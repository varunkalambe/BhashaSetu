// backend/config/languageConfig.js - CORRECTED FOR ES6
const languageConfig = {
  'hi': { name: 'हिंदी (Hindi)', fontSize: 22, maxChars: 40, maxWords: 6, delimiter: /([।!?])/ },
  'bn': { name: 'বাংলা (Bengali)', fontSize: 20, maxChars: 35, maxWords: 5, delimiter: /([।!?])/ },
  'ta': { name: 'தமிழ் (Tamil)', fontSize: 20, maxChars: 35, maxWords: 5, delimiter: /([.!?])/ },
  'te': { name: 'తెలుగు (Telugu)', fontSize: 20, maxChars: 35, maxWords: 5, delimiter: /([.!?])/ },
  'mr': { name: 'मराठी (Marathi)', fontSize: 22, maxChars: 40, maxWords: 6, delimiter: /([।!?])/ },
  'gu': { name: 'ગુજરાતી (Gujarati)', fontSize: 22, maxChars: 40, maxWords: 6, delimiter: /([।!?])/ },
  'kn': { name: 'ಕನ್ನಡ (Kannada)', fontSize: 20, maxChars: 35, maxWords: 5, delimiter: /([.!?])/ },
  'ml': { name: 'മലയാളം (Malayalam)', fontSize: 20, maxChars: 35, maxWords: 5, delimiter: /([.!?])/ },
  'pa': { name: 'ਪੰਜਾਬੀ (Punjabi)', fontSize: 22, maxChars: 40, maxWords: 6, delimiter: /([।!?])/ },
  'ur': { name: 'اردو (Urdu)', fontSize: 22, maxChars: 40, maxWords: 6, delimiter: /([۔!?])/ },
  'en': { name: 'English', fontSize: 24, maxChars: 42, maxWords: 7, delimiter: /([.!?])/ }
};

export function getConfig(lang) {
  return languageConfig[lang] || languageConfig['en'];
}
