import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

"""
Fine-tunes IndicTrans2 with a LoRA adapter using data prepared by
prepare_lora_data.py. Uses HuggingFace PEFT, per IndicTrans2's own
officially-supported LoRA fine-tuning scripts referenced in the architecture doc.
"""
import argparse, json, os
import torch
from torch.utils.data import Dataset, DataLoader
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer, get_linear_schedule_with_warmup
from peft import LoraConfig, get_peft_model, TaskType
from IndicTransToolkit.processor import IndicProcessor

FLORES_MAP = {
    "hi": "hin_Deva", "bn": "ben_Beng", "ta": "tam_Taml", "te": "tel_Telu",
    "mr": "mar_Deva", "gu": "guj_Gujr", "kn": "kan_Knda", "ml": "mal_Mlym",
    "pa": "pan_Guru", "ur": "urd_Arab", "en": "eng_Latn", "as": "asm_Beng",
    "or": "ory_Orya", "sd": "snd_Arab", "mni": "mni_Mtei"
}

class ParallelDataset(Dataset):
    def __init__(self, jsonl_path, ip, tokenizer, max_length=256):
        self.rows = [json.loads(l) for l in open(jsonl_path, encoding="utf-8")]
        self.ip = ip
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, idx):
        row = self.rows[idx]
        src_flores = FLORES_MAP.get(row["src_lang"], "eng_Latn")
        tgt_flores = FLORES_MAP.get(row["tgt_lang"], "hin_Deva")

        src_batch = self.ip.preprocess_batch([row["src"]], src_lang=src_flores, tgt_lang=tgt_flores)
        tgt_batch = self.ip.preprocess_batch([row["tgt"]], src_lang=tgt_flores, tgt_lang=src_flores)

        src_enc = self.tokenizer(src_batch, truncation=True, max_length=self.max_length,
                                  padding="max_length", return_tensors="pt")
        with self.tokenizer.as_target_tokenizer():
            tgt_enc = self.tokenizer(tgt_batch, truncation=True, max_length=self.max_length,
                                      padding="max_length", return_tensors="pt")

        labels = tgt_enc["input_ids"].squeeze(0)
        labels[labels == self.tokenizer.pad_token_id] = -100

        return {
            "input_ids": src_enc["input_ids"].squeeze(0),
            "attention_mask": src_enc["attention_mask"].squeeze(0),
            "labels": labels
        }

def train(args):
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[+] Device: {device}")

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)
    model = AutoModelForSeq2SeqLM.from_pretrained(args.base_model, trust_remote_code=True).to(device)

    lora_config = LoraConfig(
        task_type=TaskType.SEQ_2_SEQ_LM,
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        target_modules=["q_proj", "v_proj", "k_proj", "out_proj"]
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    ip = IndicProcessor(inference=False)
    train_ds = ParallelDataset(args.train_file, ip, tokenizer, args.max_length)
    val_ds = ParallelDataset(args.val_file, ip, tokenizer, args.max_length) if os.path.exists(args.val_file) else None

    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size) if val_ds else None

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    total_steps = len(train_loader) * args.epochs
    scheduler = get_linear_schedule_with_warmup(optimizer, num_warmup_steps=int(0.06 * total_steps), num_training_steps=total_steps)

    model.train()
    for epoch in range(args.epochs):
        total_loss = 0.0
        for step, batch in enumerate(train_loader):
            batch = {k: v.to(device) for k, v in batch.items()}
            outputs = model(**batch)
            loss = outputs.loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            optimizer.zero_grad()
            total_loss += loss.item()

            if step % 10 == 0:
                print(f"[epoch {epoch+1}/{args.epochs}] step {step}/{len(train_loader)} loss={loss.item():.4f}")

        avg_loss = total_loss / max(1, len(train_loader))
        print(f"[+] Epoch {epoch+1} done. avg_train_loss={avg_loss:.4f}")

        if val_loader:
            model.eval()
            val_loss = 0.0
            with torch.no_grad():
                for batch in val_loader:
                    batch = {k: v.to(device) for k, v in batch.items()}
                    val_loss += model(**batch).loss.item()
            print(f"[+] Epoch {epoch+1} val_loss={val_loss / max(1, len(val_loader)):.4f}")
            model.train()

    os.makedirs(args.output_dir, exist_ok=True)
    model.save_pretrained(args.output_dir)
    print(f"[+] LoRA adapter saved to {args.output_dir}")
    print(f"[+] Set INDICTRANS2_LORA_PATH={os.path.abspath(args.output_dir)} in .env to use it")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base_model", default="ai4bharat/indictrans2-indic-en-dist-200M")
    ap.add_argument("--train_file", default="uploads/lora_training_data/train.jsonl")
    ap.add_argument("--val_file", default="uploads/lora_training_data/val.jsonl")
    ap.add_argument("--output_dir", default="uploads/lora_adapters/indictrans2-domain")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch_size", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--max_length", type=int, default=256)
    ap.add_argument("--lora_r", type=int, default=16)
    ap.add_argument("--lora_alpha", type=int, default=32)
    ap.add_argument("--lora_dropout", type=float, default=0.05)
    args = ap.parse_args()

    if not os.path.exists(args.train_file):
        raise SystemExit(f"❌ {args.train_file} not found. Run prepare_lora_data.py first.")
    train(args)