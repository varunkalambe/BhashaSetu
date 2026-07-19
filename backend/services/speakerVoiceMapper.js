// services/speakerVoiceMapper.js
//
// Maps diarization-detected speaker segments onto translation segments so
// each translated segment can be spoken with a voice matching its actual
// speaker's register, instead of one job-level voice for the whole video.
// This is the feature the code comments in ttsService.js explicitly called
// out as "not yet built" — job-level `inferDominantSpeakerProfile()` stays
// as the fallback when this mapping can't be computed (e.g. diarization failed).

/**
 * Given raw diarization segments [{start,end,speaker}] and translation
 * segments [{start,end,text,...}], assigns each translation segment the
 * diarization speaker whose window overlaps it the most.
 */
export const mapSpeakersToTranslationSegments = (diarizationSegments, translationSegments) => {
  if (!diarizationSegments || diarizationSegments.length === 0 || !translationSegments) {
    return translationSegments.map(seg => ({ ...seg, speaker: 'SPEAKER_00' }));
  }

  return translationSegments.map(seg => {
    const segStart = seg.start ?? 0;
    const segEnd = seg.end ?? (segStart + 1);

    let bestSpeaker = diarizationSegments[0].speaker;
    let bestOverlap = 0;

    for (const dSeg of diarizationSegments) {
      const overlap = Math.max(0, Math.min(segEnd, dSeg.end) - Math.max(segStart, dSeg.start));
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSpeaker = dSeg.speaker;
      }
    }

    return { ...seg, speaker: bestSpeaker };
  });
};

/**
 * Builds a per-speaker F0 profile so each distinct diarized speaker can get
 * its own register estimate, instead of one blended "dominant speaker" F0
 * for the whole clip.
 */
// AFTER
export const buildPerSpeakerRegisterMap = (diarizationData) => {
  const registerMap = {};
  if (!diarizationData?.diarization?.segments) return registerMap;

  const speakers = [...new Set(diarizationData.diarization.segments.map(s => s.speaker))];
  const overallMeanF0 = diarizationData.f0?.mean_f0_hz ?? null;
  const overallStdF0 = diarizationData.f0?.std_f0_hz ?? null;
  const contour = diarizationData.f0?.contour;

  // ✅ FIX: previously every speaker was assigned the exact same whole-clip
  // meanF0Hz — confirmed on a real 2-speaker job where every segment logged
  // an identical pitch-correction ratio regardless of which speaker it
  // belonged to. run_diarize_prosody.py already returns a timestamped F0
  // contour (t_norm 0..1 + f0_hz); slice it using each speaker's own
  // diarized time windows to get a REAL per-speaker mean/std, instead of
  // copying the whole-clip average onto every speaker.
  const totalDuration = Math.max(
    ...diarizationData.diarization.segments.map(s => s.end || 0),
    0.001
  );

  const perSpeakerF0 = {};
  if (contour?.t_norm?.length) {
    for (const speaker of speakers) {
      const speakerSegments = diarizationData.diarization.segments.filter(s => s.speaker === speaker);
      const hz = [];
      for (let i = 0; i < contour.t_norm.length; i++) {
        const tAbs = contour.t_norm[i] * totalDuration;
        if (speakerSegments.some(seg => tAbs >= seg.start && tAbs <= seg.end)) {
          hz.push(contour.f0_hz[i]);
        }
      }
      if (hz.length >= 5) { // enough samples to trust a per-speaker estimate
        const mean = hz.reduce((a, b) => a + b, 0) / hz.length;
        const variance = hz.reduce((a, b) => a + (b - mean) ** 2, 0) / hz.length;
        perSpeakerF0[speaker] = { meanF0Hz: mean, stdF0Hz: Math.sqrt(variance) };
      }
    }
  }

  speakers.forEach((speaker, idx) => {
    const measured = perSpeakerF0[speaker];
    const meanF0 = measured?.meanF0Hz ?? overallMeanF0;
    const stdF0 = measured?.stdF0Hz ?? overallStdF0;

    let register = 'unknown', confidence = 'low';
    if (meanF0 && meanF0 > 0) {
      register = meanF0 < 165 ? 'lower' : 'higher';
      confidence = measured ? 'medium' : (idx === 0 ? 'medium' : 'low');
      if (!measured && idx > 0) {
        // No usable contour samples for this speaker — fall back to the old
        // relative-contrast guess rather than silently giving it speaker 0's
        // exact number with no distinction at all.
        register = overallMeanF0 < 165 ? 'higher' : 'lower';
      }
    }
    registerMap[speaker] = { register, confidence, meanF0Hz: meanF0, stdF0Hz: stdF0 };
  });

  return registerMap;
};
export default { mapSpeakersToTranslationSegments, buildPerSpeakerRegisterMap };