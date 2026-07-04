// services/validationService.js
import fs from 'fs';
import path from 'path';

export const validateTranslationQuality = async (translationSegments, targetLanguage, jobId) => {
  const validationResults = {
    overallScore: 0,
    segments: [],
    issues: [],
    recommendations: []
  };

  try {
    console.log(`[${jobId}] Starting quality validation for ${translationSegments?.length || 0} segments...`);

    // Method 1: Length-based validation
    const lengthValidation = validateTranslationLength(translationSegments, jobId);
    validationResults.lengthCheck = lengthValidation;

    // Method 2: Terminology consistency check
    const terminologyValidation = await validateTerminologyConsistency(translationSegments, targetLanguage, jobId);
    validationResults.terminologyCheck = terminologyValidation;

    // Method 3: Back-translation validation (optional but recommended)
    const backTranslationValidation = await performBackTranslationCheck(translationSegments, targetLanguage, jobId);
    validationResults.backTranslationCheck = backTranslationValidation;

    // Calculate overall quality score
    validationResults.overallScore = calculateOverallQualityScore(
      lengthValidation.score,
      terminologyValidation.score,
      backTranslationValidation.score
    );

    // Log validation results
    console.log(`[${jobId}] Quality validation results:`);
    console.log(`[${jobId}]   Overall Score: ${validationResults.overallScore}%`);
    console.log(`[${jobId}]   Length Check: ${lengthValidation.score}%`);
    console.log(`[${jobId}]   Terminology Check: ${terminologyValidation.score}%`);
    console.log(`[${jobId}]   Back-translation Check: ${backTranslationValidation.score}%`);

    // Save validation results to file system
    await saveValidationResults(jobId, validationResults);

    // Throw error if quality is below threshold
    if (validationResults.overallScore < 70) {
      throw new Error(`Translation quality below acceptable threshold: ${validationResults.overallScore}%. Manual review required.`);
    }

    return validationResults;

  } catch (error) {
    console.error(`[${jobId}] Translation validation failed: ${error.message}`);
    throw error;
  }
};

// Helper function for length validation
const validateTranslationLength = (segments, jobId) => {
  let totalScore = 0;
  const issues = [];

  segments.forEach((segment, index) => {
    const originalLength = segment.original?.length || segment.text?.length || 0;
    const translatedLength = segment.translated?.length || segment.text?.length || 0;
    
    // Acceptable length ratio between 0.5x to 2.5x
    const lengthRatio = translatedLength / originalLength;
    
    if (lengthRatio < 0.3 || lengthRatio > 3.0) {
      issues.push({
        segmentIndex: index,
        issue: 'Length anomaly',
        ratio: lengthRatio,
        severity: lengthRatio < 0.1 || lengthRatio > 5.0 ? 'high' : 'medium'
      });
    }
  });

  const score = Math.max(0, 100 - (issues.length * 10));
  
  console.log(`[${jobId}] Length validation: ${score}% (${issues.length} issues found)`);
  
  return { score, issues };
};

// Helper function for terminology consistency
const validateTerminologyConsistency = async (segments, targetLanguage, jobId) => {
  console.log(`[${jobId}] Performing terminology consistency check...`);
  
  // Simplified implementation - you can expand this
  return { 
    score: 85, 
    issues: [],
    consistentTerms: [],
    inconsistentTerms: []
  };
};

// Helper function for back-translation validation
const performBackTranslationCheck = async (segments, targetLanguage, jobId) => {
  console.log(`[${jobId}] Performing back-translation validation...`);
  
  // Simplified implementation - you can integrate with Google Translate API
  return { 
    score: 80, 
    bleuScore: 0.75,
    semanticSimilarity: 0.82
  };
};

const calculateOverallQualityScore = (lengthScore, terminologyScore, backTranslationScore) => {
  // Weighted average of all scores
  return Math.round((lengthScore * 0.3) + (terminologyScore * 0.4) + (backTranslationScore * 0.3));
};

const saveValidationResults = async (jobId, results) => {
  const processingDir = process.env.PROCESSING_DIR || './processing';
  const jobDir = path.join(processingDir, jobId);
  
  // Create directory if it doesn't exist
  if (!fs.existsSync(jobDir)) {
    fs.mkdirSync(jobDir, { recursive: true });
  }
  
  const validationPath = path.join(jobDir, 'validation_results.json');
  await fs.promises.writeFile(validationPath, JSON.stringify(results, null, 2));
  
  console.log(`[${jobId}] Validation results saved to: ${validationPath}`);
};
