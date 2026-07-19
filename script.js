'use strict';

// 🔥 GLOBAL LOCKS
let isProcessing = false;
let uploadInProgress = false;

console.log('✅ Script loaded');



console.log('✅ Refresh protection enabled');



// ✅ PROCESSING STATE TRACKER


// ---------------- Welcome Overlay ----------------
window.addEventListener('load', () => {
    const overlay = document.getElementById('welcomeOverlay');
    const lang = document.documentElement.lang;

    // Set welcome message based on language
    let title = "Welcome to APNI VAANI";
    let subtitle = "Breaking Barriers, Connecting Voices";

    if (lang === "kn") {
        title = "ಅಪ್ನಿ ವಾಣಿ ಗೆ ಸ್ವಾಗತ";
        subtitle = "ಅಡೆತಡೆಗಳನ್ನು ಮುರಿದು, ಧ್ವನಿಗಳನ್ನು ಸಂಪರ್ಕಿಸುವುದು";
    } else if (lang === "hi") {
        title = "अपनी वाणी में आपका स्वागत है";
        subtitle = "बाधाओं को तोड़ना, आवाज़ों को जोड़ना";
    }

    if (overlay) {
        overlay.querySelector('h1').textContent = title;
        overlay.querySelector('p').textContent = subtitle;

        setTimeout(() => {
            overlay.classList.add('fadeOut');
        }, 3000);
    }

});


const API_BASE_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? `http://${window.location.hostname}:${window.location.port || 7860}`  // ✅ Development - matches whatever port the page is served on
    : '';  // ✅ Production - use relative URLs (empty string)


let currentJobId = null;
let selectedFile = null;



// ✅ ADD THESE HELPER FUNCTIONS IF MISSING
function showNotification(message) {
    const notification = document.getElementById('notification');
    const notificationText = document.getElementById('notificationText');

    if (notification && notificationText) {
        notificationText.textContent = message;
        notification.style.display = 'block';
        notification.classList.add('show');

        setTimeout(() => {
            notification.classList.remove('show');
        }, 5000);
    }
    console.log('📢', message);
}

function updateProgress(percentage) {
    const progressFill = document.getElementById('progressFill');
    if (progressFill) {
        progressFill.style.width = percentage + '%';
    }
}


console.log('✅ Script loaded');
console.log('✅ Refresh protection enabled');

// 🔥 DEBUG: Check if button exists
document.addEventListener('DOMContentLoaded', () => {
    console.log('🔍 DOM LOADED');

    const translateBtn = document.getElementById('translateBtn');
    const fileInput = document.getElementById('videoFile');
    const fromLang = document.getElementById('fromLang');
    const toLang = document.getElementById('toLang');

    console.log('🔍 translateBtn found:', !!translateBtn);
    console.log('🔍 fileInput found:', !!fileInput);
    console.log('🔍 fromLang found:', !!fromLang);
    console.log('🔍 toLang found:', !!toLang);

    if (translateBtn) {
        console.log('🔍 Button classes:', translateBtn.className);
        console.log('🔍 Button disabled:', translateBtn.disabled);
        console.log('🔍 Button type:', translateBtn.type);
    }
});



// ✅ SINGLE TRANSLATE FUNCTION



// ---------------- Wait until DOM is loaded ----------------
document.addEventListener('DOMContentLoaded', () => {
    // ✅ GLOBAL FORM SUBMISSION PREVENTION
    document.addEventListener('submit', (e) => {
        console.log('ðŸš« Form submission prevented:', e.target);
        e.preventDefault();
        e.stopPropagation();
        return false;
    }, true);  // ✅ ADD CAPTURE PHASE

    // ✅ PREVENT ALL BUTTON DEFAULT ACTIONS (if they're in forms)
    document.addEventListener('click', (e) => {
        if (e.target.type === 'submit' && e.target.id !== 'translateBtn') {
            console.log('🚫 Submit button click prevented:', e.target.id);
            e.preventDefault();
            return false;
        }
    });

    // === SELECT ELEMENTS ===
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('videoFile');
    const progressBar = document.getElementById('progressBar');
    const progressFill = document.getElementById('progressFill');
    const fileInfo = document.getElementById('fileInfo');
    const fileName = document.getElementById('fileName');
    const fileSize = document.getElementById('fileSize');
    const languageSelector = document.getElementById('languageSelector');
    const translateBtn = document.getElementById('translateBtn');
    const notification = document.getElementById('notification');
    const notificationText = document.getElementById('notificationText');



    // === PREVENT NAVIGATION DURING PROCESSING ===
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function () {
        if (isProcessing) {
            console.log('🚫 Navigation blocked - processing in progress');
            return;
        }
        return originalPushState.apply(this, arguments);
    };

    history.replaceState = function () {
        if (isProcessing) {
            console.log('🚫 Navigation blocked - processing in progress');
            return;
        }
        return originalReplaceState.apply(this, arguments);
    };




    // === SMOOTH SCROLL FOR NAV LINKS ===
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = anchor.getAttribute('href');
            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                targetElement.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });


    // === PREVENT LINK CLICKS DURING PROCESSING ===
    document.addEventListener('click', (e) => {
        if (isProcessing && e.target.tagName === 'A') {
            e.preventDefault();
            e.stopPropagation();
            showNotification('⚠️ Please wait for processing to complete');
            return false;
        }
    }, true);





    // === DRAG & DROP / CLICK UPLOAD HANDLERS ===
    if (uploadZone && fileInput) {
        console.log('✅ Attaching uploadZone click handler');
        uploadZone.addEventListener('click', () => {
            console.log('📁 Upload zone clicked');
            fileInput.click();
        });
    } else {
        console.error('❌ uploadZone or fileInput not found');
    }



    if (uploadZone) {
        console.log('✅ Attaching dragover handler');
        uploadZone.addEventListener('dragover', (e) => {
            console.log('🔵 Dragover detected');
            e.preventDefault();
            e.stopPropagation();
            uploadZone.classList.add('dragover');
        });
    } else {
        console.error('❌ uploadZone not found for dragover');
    }


    if (uploadZone) {
        console.log('✅ Attaching dragleave handler');
        uploadZone.addEventListener('dragleave', (e) => {
            console.log('🔵 Dragleave detected');
            e.preventDefault();
            uploadZone.classList.remove('dragover');
        });
    } else {
        console.error('❌ uploadZone not found for dragleave');
    }


    if (uploadZone) {
        console.log('✅ Attaching drop handler');
        uploadZone.addEventListener('drop', (e) => {
            console.log('🔵 Drop detected');
            e.preventDefault();
            e.stopPropagation();
            uploadZone.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) {
                console.log('📁 File dropped:', e.dataTransfer.files[0].name);
                handleFileSelect(e.dataTransfer.files[0]);
            }
        });
    } else {
        console.error('❌ uploadZone not found for drop');
    }


    if (fileInput) {
        console.log('✅ Attaching fileInput change handler');
        fileInput.addEventListener('change', (e) => {
            console.log('📁 File input changed');
            if (e.target.files.length > 0) {
                console.log('📁 File selected via input:', e.target.files[0].name);
                handleFileSelect(e.target.files[0]);
            }
        });
    } else {
        console.error('❌ fileInput not found for change handler');
    }


    // === HANDLE FILE SELECTION ===
    function handleFileSelect(file) {
        console.log('🎬 File selected:', file.name);

        const allowedTypes = ['video/mp4', 'video/avi', 'video/quicktime', 'video/x-ms-wmv'];
        if (!allowedTypes.includes(file.type)) {
            showNotification('❌ Please select a valid video file (MP4, AVI, MOV, WMV)');
            return;
        }

        const maxSize = 100 * 1024 * 1024; // 100MB
        if (file.size > maxSize) {
            showNotification('❌ File size exceeds 100MB limit');
            return;
        }

        // Store file
        selectedFile = file;

        fileName.textContent = file.name;
        fileSize.textContent = (file.size / 1024 / 1024).toFixed(2) + ' MB';
        fileInfo.style.display = 'block';

        // Show language selector immediately
        languageSelector.style.display = 'block';
        translateBtn.classList.add('active');

        showNotification('✅ File selected! Choose languages and click Translate.');
    }

    // ✅ ENHANCED TRANSLATE BUTTON CLICK HANDLER
    if (translateBtn) {
        console.log('✅ Attaching SECOND translateBtn handler');
        console.log('🔍 uploadVideoToBackend exists:', typeof uploadVideoToBackend);
        console.log('🔍 checkProcessingStatus exists:', typeof checkProcessingStatus);

        // 🔥 ADD THIS TEST
        translateBtn.addEventListener('mouseover', () => {
            console.log('👆 Mouse is over translate button');
        });


        translateBtn.addEventListener('click', async (e) => {
            console.log('🔥🔥🔥 CLICK EVENT FIRED ON TRANSLATEBTN!!!');
            console.log('🚀 SECOND translate button handler fired');
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            if (isProcessing) {
                console.log('❌ Already processing, ignoring click');
                return false;
            }

            console.log('🚀 Translate button clicked');

            if (!translateBtn.classList.contains('active')) {
                console.log('⚠️ Button not active');
                return false;
            }

            if (!selectedFile) {
                showNotification('❌ Please select a video file first');
                return;
            }

            // Get selected languages
            const fromLang = document.getElementById('fromLang').value;
            const toLang = document.getElementById('toLang').value;

            if (!fromLang || !toLang) {
                showNotification('❌ Please select both source and target languages');
                return;
            }

            console.log(`🎯 Languages: ${fromLang} → ${toLang}`);

            // ✅ DISABLE BUTTON AND PREVENT MULTIPLE CLICKS 
            translateBtn.disabled = true;
            translateBtn.style.pointerEvents = 'none';
            translateBtn.textContent = '⏳ Uploading...';
            isProcessing = true;  // ✅ LOCK PAGE

            try {
                // ✅ REAL UPLOAD TO BACKEND
                showNotification('📤 Uploading... 5%');

                const jobId = await uploadVideoToBackend(selectedFile, fromLang, toLang);

                if (!jobId) {
                    throw new Error('Failed to get job ID from upload');
                }

                currentJobId = jobId;
                console.log('✅ Upload successful! Job ID:', jobId);

                // Show progress bar
                progressBar.style.display = 'block';
                progressFill.style.width = '0%';

                showNotification('🚀 Translation started! Processing your video...');
                translateBtn.textContent = '⏳ Processing...';

                // ✅ SHOW PROCESSING MESSAGE
                document.getElementById('processingMessage').classList.add('show');

                // ✅ REAL STATUS CHECKING
                checkProcessingStatus(jobId);

            } catch (error) {
                console.error('❌ Translation error:', error);
                showNotification('❌ Error: ' + error.message);

                // ✅ RE-ENABLE BUTTON ON ERROR
                translateBtn.disabled = false;
                translateBtn.style.pointerEvents = 'auto';
                translateBtn.textContent = '🚀 Translate Video';
                isProcessing = false;  // ✅ UNLOCK

                // ✅ HIDE PROCESSING MESSAGE ON ERROR
                document.getElementById('processingMessage').classList.remove('show');
            }
        }); // ✅ CLOSE addEventListener
    } else {
        console.error('❌ translateBtn not found for SECOND handler');
    }



    // ===== KEYBOARD SHORTCUTS =====
    document.addEventListener('keydown', (e) => {
        const popup = document.getElementById('resultPopup');

        // ✅ ESCAPE KEY - Close popup
        if (e.key === 'Escape' && popup && popup.style.display === 'block') {
            console.log('⌨️ Escape key pressed - closing popup');
            e.preventDefault();
            closePopup();
        }

        // ✅ ENTER KEY - Download (when popup is open)
        if (e.key === 'Enter' && popup && popup.style.display === 'block') {
            const downloadBtn = document.getElementById('popupDownloadBtn');
            if (downloadBtn && !downloadBtn.disabled) {
                console.log('⌨️ Enter key pressed - triggering download');
                e.preventDefault();
                downloadBtn.click();
            }
        }
    });

    console.log('✅ Keyboard shortcuts registered');



}); // ✅ CLOSE DOMContentLoaded




// ✅ REAL UPLOAD FUNCTION
async function uploadVideoToBackend(file, fromLang, toLang) {
    console.log('📤 Starting upload to backend...');

    const formData = new FormData();
    formData.append('video', file);
    formData.append('fromLang', fromLang);
    formData.append('toLang', toLang);

    console.log('📦 FormData prepared:', {
        file: file.name,
        fromLang: fromLang,
        toLang: toLang
    });

    try {
        const response = await fetch(`${API_BASE_URL}/api/upload`, {
            method: 'POST',
            body: formData
        });

        console.log('📥 Upload response status:', response.status);

        if (!response.ok) {
            const errorData = await response.json();
            console.error('❌ Upload failed:', errorData);
            throw new Error(errorData.message || 'Upload failed');
        }

        const data = await response.json();
        console.log('✅ Upload response:', data);

        return data.jobId;

    } catch (error) {
        console.error('❌ Upload error:', error);
        throw error;
    }
}

// ✅ STATUS CHECKING WITH FIXED 12-SECOND POLLING
let pollCount = 0;
const POLL_INTERVAL_MS = 15000; // ✅ CHANGED from 12000 to 15000 (15s)

async function checkProcessingStatus(jobId) {
    console.log(`🔍 [${new Date().toISOString()}] Checking status for job: ${jobId} (poll #${pollCount + 1})`);

    try {
        const response = await fetch(`${API_BASE_URL}/api/process/status/${jobId}`);
        const data = await response.json();

        console.log('📊 RAW STATUS DATA:', JSON.stringify(data, null, 2));
        console.log('🔍 data.status =', data.status);
        console.log('🔍 data.step =', data.step);

        // ✅ COMPLETION CHECK
        if (data.status === 'completed' || data.step === 'completed') {
            console.log('🎉🎉🎉 COMPLETION DETECTED - SHOWING POPUP NOW!!!');

            // ✅ HIDE PROCESSING MESSAGE WHEN COMPLETE
document.getElementById('processingMessage').classList.remove('show');

            // ✅ STOP POLLING
            if (window.statusCheckTimeout) {
                clearTimeout(window.statusCheckTimeout);
            }

            // ✅ UNLOCK PAGE
            isProcessing = false;

            // ✅ RESET POLL COUNTER
            pollCount = 0;

            // Show popup immediately
            const videoUrl = `${API_BASE_URL}/uploads/processed/${jobId}_final.mp4`;
            console.log('🔗 Final video URL:', videoUrl);

            showPopup(jobId);
            return;
        }

        // ✅ CONTINUE POLLING EVERY 12 SECONDS
        pollCount++;
        console.log(`⏳ Still processing... checking again in 12s (poll #${pollCount})`);
        window.statusCheckTimeout = setTimeout(() => checkProcessingStatus(jobId), POLL_INTERVAL_MS);

    } catch (error) {
    console.error('❌ Status check error:', error);

    // ✅ HIDE PROCESSING MESSAGE ON ERROR
    document.getElementById('processingMessage').classList.remove('show');

    // ✅ RESET ON ERROR AND RETRY
    pollCount = 0;

    console.log('🔄 Retrying in 12 seconds...');
    setTimeout(() => checkProcessingStatus(jobId), POLL_INTERVAL_MS);
}
}





// ===== SHOW POPUP FUNCTION (IMPROVED) =====
function showPopup(jobId) {
    console.log('🎬🎬🎬 showPopup() CALLED with jobId:', jobId);

    const popup = document.getElementById('resultPopup');
    console.log('📦 Popup element found:', !!popup);

    if (!popup) {
        console.error('❌ POPUP ELEMENT NOT FOUND IN HTML!');
        alert(`Video ready! Job ID: ${jobId}\nURL: ${API_BASE_URL}/uploads/processed/${jobId}_final.mp4`);
        return;
    }

    const videoUrl = `${API_BASE_URL}/uploads/processed/${jobId}_final.mp4`;
    console.log('🔗 Setting video URL:', videoUrl);

    const videoSource = document.getElementById('popupVideoSource');
    const video = document.getElementById('popupVideo');
    const downloadBtn = document.getElementById('popupDownloadBtn');

    if (videoSource) {
        videoSource.src = videoUrl;
        console.log('✅ Video source set');
    }

    if (video) {
        video.load();
        console.log('✅ Video loaded');
    }

    // ✅ FIX DOWNLOAD BUTTON - Force download using fetch + blob
    if (downloadBtn) {
        // Remove any existing click handlers
        downloadBtn.replaceWith(downloadBtn.cloneNode(true));
        const newDownloadBtn = document.getElementById('popupDownloadBtn');

        // Add proper download handler
        newDownloadBtn.addEventListener('click', async (e) => {
            e.preventDefault(); // ✅ Prevent default link behavior
            e.stopPropagation();

            console.log('⬇️ Download button clicked');
            newDownloadBtn.textContent = '⏳ Downloading...';
            newDownloadBtn.disabled = true;

            try {
                // ✅ Fetch video as blob
                const response = await fetch(videoUrl);
                if (!response.ok) throw new Error('Download failed');

                const blob = await response.blob();

                // ✅ Create download link and trigger
                const downloadUrl = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = downloadUrl;
                a.download = `translated_video_${jobId}.mp4`;

                document.body.appendChild(a);
                a.click();

                // Cleanup
                window.URL.revokeObjectURL(downloadUrl);
                document.body.removeChild(a);

                console.log('✅ Download initiated successfully');
                newDownloadBtn.textContent = '✅ Downloaded!';

                setTimeout(() => {
                    newDownloadBtn.textContent = '⬇️ Download Video';
                    newDownloadBtn.disabled = false;
                }, 2000);

            } catch (error) {
                console.error('❌ Download error:', error);
                alert('Download failed. Please try again.');
                newDownloadBtn.textContent = '⬇️ Download Video';
                newDownloadBtn.disabled = false;
            }
        });

        console.log('✅ Download button configured with proper handler');
    }

    // ✅ SHOW POPUP
    popup.style.display = 'block';
    popup.style.visibility = 'visible';
    popup.style.opacity = '1';

    // ✅ PREVENT BODY SCROLL
    document.body.style.overflow = 'hidden';

    // ✅ SCROLL TO TOP
    popup.scrollTop = 0;

    console.log('✅✅✅ POPUP DISPLAYED WITH WORKING DOWNLOAD!');
}


// ===== CLOSE POPUP FUNCTION (IMPROVED) =====
function closePopup() {
    console.log('🚪 Closing popup...');

    const popup = document.getElementById('resultPopup');
    const video = document.getElementById('popupVideo');

    if (popup) {
        // ✅ HIDE POPUP
        popup.style.display = 'none';
        popup.style.opacity = '0';

        // ✅ RE-ENABLE BODY SCROLL
        document.body.style.overflow = 'auto';

        console.log('✅ Popup closed');
    }

    // ✅ STOP VIDEO PLAYBACK
    if (video) {
        video.pause();
        video.currentTime = 0;
        console.log('✅ Video stopped');
    }
}


// ===== TRANSLATE ANOTHER FUNCTION (IMPROVED) =====
function translateAnother() {
    console.log('🔄 Starting new translation...');

    // ✅ CLOSE POPUP FIRST
    closePopup();

    // ✅ RESET FORM
    const fileInput = document.getElementById('videoFile');
    if (fileInput) fileInput.value = '';

    const fileInfo = document.getElementById('fileInfo');
    if (fileInfo) fileInfo.style.display = 'none';

    const progressBar = document.getElementById('progressBar');
    if (progressBar) progressBar.style.display = 'none';

    const progressFill = document.getElementById('progressFill');
    if (progressFill) progressFill.style.width = '0%';

    const translateBtn = document.getElementById('translateBtn');
    if (translateBtn) {
        translateBtn.textContent = '🚀 Translate Video';
        translateBtn.disabled = false;
        translateBtn.classList.remove('active');
        translateBtn.style.pointerEvents = 'auto';
    }

    const languageSelector = document.getElementById('languageSelector');
    if (languageSelector) languageSelector.style.display = 'none';

    // ✅ RESET LANGUAGE SELECTORS TO DEFAULT
    const fromLang = document.getElementById('fromLang');
    const toLang = document.getElementById('toLang');
    if (fromLang) fromLang.value = 'en';
    if (toLang) toLang.value = 'hi';

    // ✅ RESET GLOBAL VARIABLES
    selectedFile = null;
    currentJobId = null;
    isProcessing = false;

    // ✅ SCROLL TO UPLOAD SECTION
    const uploadSection = document.getElementById('video-translate');
    if (uploadSection) {
        uploadSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    showNotification('✅ Ready for new translation');
    console.log('✅ Form reset complete');
}



// ---------------- Language Selection Notes ----------------
function showSelected(selectId, noteId) {
    const select = document.getElementById(selectId);
    const note = document.getElementById(noteId);
    const selectedText = select.options[select.selectedIndex].text;

    const lang = document.documentElement.lang;

    let msg = `You selected: ${selectedText}`; // default English
    if (lang === "kn") msg = `ನೀವು ಆಯ್ಕೆಮಾಡಿದವು: ${selectedText}`;
    else if (lang === "hi") msg = `आपने चुना: ${selectedText}`;

    note.textContent = msg;
}
