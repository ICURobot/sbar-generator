document.addEventListener('DOMContentLoaded', () => {
    // All variable declarations
    const generateBtn = document.getElementById('generate-sbar-btn');
    const modal = document.getElementById('sbar-modal');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const reportContentContainer = document.getElementById('report-content-container');
    const copyReportBtn = document.getElementById('copy-report-btn');
    const copySuccessMsg = document.getElementById('copy-success-msg');
    const form = document.getElementById('assessment-form');
    const formOverlay = document.getElementById('form-overlay');
    const userInfo = document.getElementById('user-info');
    const authBtn = document.getElementById('auth-btn');
    const privacyModal = document.getElementById('privacy-modal');
    const closePrivacyModalBtn = document.getElementById('close-privacy-modal');
    const saveStatus = document.getElementById('save-status');
    const clearFormBtn = document.getElementById('clear-form-btn');
    const reportCaptureContainer = document.getElementById('report-capture-container');
    const recordBtn = document.getElementById('record-btn');
    const transcriptBox = document.getElementById('transcript-box');
    const textInputBox = document.getElementById('text-input-box');
    const imageInput = document.getElementById('image-input');
    const selectImageBtn = document.getElementById('select-image-btn');
    const imagePreview = document.getElementById('image-preview');
    const imagePreviewContainer = document.getElementById('image-preview-container');
    const removeImageBtn = document.getElementById('remove-image-btn');
    const captureStatus = document.getElementById('capture-status');
    const processReportBtn = document.getElementById('process-report-btn');
    const processBtnText = document.getElementById('process-btn-text');
    const processLoading = document.getElementById('process-loading');
    
    // Tab elements
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');

    let lastReportJson = null;
    let saveTimeout;
    let recognition;
    let isRecording = false;

    // Privacy Modal Logic
    function checkPrivacyDisclaimer() {
        const today = new Date().toISOString().split('T')[0];
        const lastShown = localStorage.getItem('disclaimerShownDate');
        if (lastShown !== today) {
            privacyModal.classList.remove('hidden');
        }
    }
    closePrivacyModalBtn.addEventListener('click', () => {
        privacyModal.classList.add('hidden');
        const today = new Date().toISOString().split('T')[0];
        localStorage.setItem('disclaimerShownDate', today);
    });
    checkPrivacyDisclaimer();
    
    // Auto-Save and Load Logic (using localStorage instead of backend)
    async function saveDraft() {
        const formData = collectFormData();
        saveStatus.textContent = 'Saving...';
        // Save to localStorage
        localStorage.setItem('sbar_draft', JSON.stringify(formData));
        saveStatus.textContent = 'Draft Saved!';
        setTimeout(() => { saveStatus.textContent = ''; }, 2000);
    }

    async function loadDraft() {
        try {
            const saved = localStorage.getItem('sbar_draft');
            if (saved) {
                const formData = JSON.parse(saved);
                populateForm(formData);
            }
        } catch (error) { console.error("Could not load draft:", error); }
    }
    
    function populateForm(formData) {
        for (const key in formData) {
            const element = document.getElementById(key);
            if (element) { element.value = formData[key]; }
        }
    }

    form.addEventListener('input', () => {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(saveDraft, 2000); 
    });
    
    clearFormBtn.addEventListener('click', () => {
        if(confirm('Are you sure you want to clear the entire form? This cannot be undone.')) {
            form.querySelectorAll('input, textarea').forEach(el => el.value = '');
            saveDraft();
        }
    });

    // Authentication Logic (simplified - no Netlify required)
    function updateLoginState() {
        // Always allow access - no authentication required for local development
        userInfo.textContent = 'Ready to use';
        authBtn.style.display = 'none'; // Hide auth button
        formOverlay.classList.add('hidden');
        generateBtn.disabled = false;
        reportCaptureContainer.classList.remove('hidden');
        loadDraft();
    }
    
    // Initialize on page load
    updateLoginState();

    // Tab Switching Logic
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.dataset.tab;
            
            // Update active tab
            tabButtons.forEach(b => {
                b.classList.remove('border-blue-500', 'text-blue-600');
                b.classList.add('text-gray-600');
            });
            btn.classList.add('border-blue-500', 'text-blue-600');
            btn.classList.remove('text-gray-600');
            
            // Show/hide panels
            tabPanels.forEach(panel => panel.classList.add('hidden'));
            document.getElementById(`panel-${targetTab}`).classList.remove('hidden');
            
            // Update process button state
            updateProcessButtonState();
        });
    });

    // Update process button enabled state based on current tab
    function updateProcessButtonState() {
        const activeTab = document.querySelector('.tab-btn.border-blue-500')?.dataset.tab;
        let hasContent = false;
        
        if (activeTab === 'voice' || activeTab === 'text') {
            const textValue = activeTab === 'voice' ? transcriptBox.value.trim() : textInputBox.value.trim();
            hasContent = textValue.length > 0;
        } else if (activeTab === 'image') {
            hasContent = imageInput.files && imageInput.files.length > 0;
        }
        
        processReportBtn.disabled = !hasContent;
    }

    // Speech Recognition Logic
    if ('webkitSpeechRecognition' in window) {
        recognition = new webkitSpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-CA'; 

        recognition.onstart = () => {
            isRecording = true;
            captureStatus.textContent = 'Listening... Click the microphone again to stop.';
            recordBtn.classList.add('recording', 'bg-red-200');
        };

        recognition.onend = () => {
            isRecording = false;
            captureStatus.textContent = '';
            recordBtn.classList.remove('recording', 'bg-red-200');
            updateProcessButtonState();
        };

        recognition.onresult = (event) => {
            let finalTranscript = transcriptBox.value.split('...')[0];
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript;
                }
            }
            transcriptBox.value = finalTranscript;
            updateProcessButtonState();
        };

        recordBtn.addEventListener('click', () => {
            if (isRecording) {
                recognition.stop();
            } else {
                transcriptBox.value = ''; 
                recognition.start();
            }
        });
    } else {
        // Hide voice tab if not supported
        const voiceTab = document.getElementById('tab-voice');
        if (voiceTab) {
            voiceTab.style.display = 'none';
            // Switch to text tab by default
            document.getElementById('tab-text').click();
        }
    }

    // Text input monitoring
    transcriptBox.addEventListener('input', updateProcessButtonState);
    textInputBox.addEventListener('input', updateProcessButtonState);

    // Image upload handling
    selectImageBtn.addEventListener('click', () => imageInput.click());
    
    imageInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                imagePreview.src = event.target.result;
                imagePreviewContainer.classList.remove('hidden');
                updateProcessButtonState();
            };
            reader.readAsDataURL(file);
        }
    });

    removeImageBtn.addEventListener('click', () => {
        imageInput.value = '';
        imagePreviewContainer.classList.add('hidden');
        imagePreview.src = '';
        updateProcessButtonState();
    });

    // Process Report Button
    processReportBtn.addEventListener('click', async () => {
        const activeTab = document.querySelector('.tab-btn.border-blue-500')?.dataset.tab;
        if (!activeTab) return;

        processReportBtn.disabled = true;
        processBtnText.textContent = 'Processing with AI...';
        processLoading.classList.remove('hidden');
        captureStatus.textContent = '';

        try {
            const formData = new FormData();
            formData.append('input_type', activeTab);

            if (activeTab === 'image' && imageInput.files && imageInput.files[0]) {
                formData.append('image', imageInput.files[0]);
            } else if ((activeTab === 'voice' || activeTab === 'text')) {
                const textValue = activeTab === 'voice' ? transcriptBox.value.trim() : textInputBox.value.trim();
                if (textValue) {
                    formData.append('text', textValue);
                }
            }

            const response = await fetch('http://localhost:8000/process_report', {
                method: 'POST',
                mode: 'cors',
                headers: {
                    'Accept': 'application/json'
                },
                body: formData
            });

            if (!response.ok) {
                const errorData = await response.json();
                captureStatus.textContent = `Error: ${errorData.detail || 'Failed to process report'}`;
                captureStatus.classList.add('text-red-500');
                return;
            }

            const result = await response.json();
            populateForm(result.formData);
            captureStatus.textContent = '✅ Form filled successfully!';
            captureStatus.classList.remove('text-red-500');
            captureStatus.classList.add('text-green-600');
            
            setTimeout(() => {
                captureStatus.textContent = '';
                captureStatus.classList.remove('text-green-600');
            }, 4000);
        } catch (error) {
            console.error("Error processing report:", error);
            captureStatus.textContent = `Error: ${error.message}. Make sure the FastAPI server is running.`;
            captureStatus.classList.add('text-red-500');
        } finally {
            processReportBtn.disabled = false;
            processBtnText.textContent = '✨ Process & Fill Form';
            processLoading.classList.add('hidden');
            updateProcessButtonState();
        }
    });

    // SBAR Generation and Modal Logic
    generateBtn.addEventListener('click', handleGenerateSbar);
    closeModalBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => e.target === modal && closeModal());
    copyReportBtn.addEventListener('click', copyReportToClipboard);

    function collectFormData() {
        const data = {};
        Array.from(form.querySelectorAll('input, textarea')).forEach(el => {
            if (el.id && el.value.trim()) {
                data[el.id] = el.value.trim();
            }
        });
        return data;
    }

    async function handleGenerateSbar() {
        await saveDraft(); 
        const formData = collectFormData();
        if (Object.keys(formData).length === 0) {
            alert("Please fill out some patient information first.");
            return;
        }

        openModal();
        reportContentContainer.innerHTML = `<div class="flex flex-col items-center justify-center h-full"><div class="loader ease-linear rounded-full border-8 border-t-8 border-gray-200 h-24 w-24 mb-4"></div><p class="text-lg font-semibold text-gray-600">Generating report...</p></div>`;
        
        try {
            // Call FastAPI backend
            const response = await fetch('http://localhost:8000/generate_sbar', {
                method: 'POST',
                mode: 'cors',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ patientData: formData })
            });
            if (!response.ok) {
                await displayError(reportContentContainer, response);
                return;
            }
            const result = await response.json();
            lastReportJson = result.report; 
            renderReport(lastReportJson);
        } catch (error) {
            // This will now only catch network errors or other unexpected issues
            reportContentContainer.innerHTML = `<div class="p-6"><p class="text-red-500 font-semibold">A network error occurred: ${error.message}. Make sure the FastAPI server is running on http://localhost:8000</p></div>`;
        }
    }
    
    function renderReport(report) {
        const sectionColors = {
            situation: 'bg-blue-50 border-blue-200 text-blue-800',
            background: 'bg-indigo-50 border-indigo-200 text-indigo-800',
            assessment: 'bg-green-50 border-green-200 text-green-800',
            recommendation: 'bg-amber-50 border-amber-200 text-amber-800',
            ai_suggestion: 'bg-rose-50 border-rose-200 text-rose-800'
        };

        let html = '';
        for (const key in report) {
            if (Object.hasOwnProperty.call(report, key) && report[key]) {
                const title = key === 'ai_suggestion' ? 'AI Suggestion' : (key.charAt(0).toUpperCase() + key.slice(1));
                const colorClasses = sectionColors[key] || 'bg-gray-50 border-gray-200';
                html += `<div class="p-4 rounded-lg border ${colorClasses} shadow-sm"><h3 class="text-lg font-bold text-gray-900 mb-2">${title}</h3><p class="text-gray-700 whitespace-pre-wrap">${report[key]}</p></div>`;
            }
        }
        reportContentContainer.innerHTML = html;
    }

    function copyReportToClipboard() {
        if (!lastReportJson) return;
        let plainText = '';
        for (const key in lastReportJson) {
            if (Object.hasOwnProperty.call(lastReportJson, key) && lastReportJson[key]) {
                 const title = key === 'ai_suggestion' ? '**AI Suggestion**' : `**${key.charAt(0).toUpperCase() + key.slice(1)}**`;
                 plainText += `${title}\n${lastReportJson[key]}\n\n`;
            }
        }
        const tempTextArea = document.createElement('textarea');
        tempTextArea.value = plainText.trim();
        document.body.appendChild(tempTextArea);
        tempTextArea.select();
        document.execCommand('copy');
        document.body.removeChild(tempTextArea);
        copySuccessMsg.classList.remove('hidden');
        setTimeout(() => copySuccessMsg.classList.add('hidden'), 2000);
    }

    function openModal() {
        modal.classList.remove('hidden');
        setTimeout(() => {
            modal.style.opacity = '1';
            modal.querySelector('.modal-content').style.transform = 'scale(1)';
        }, 10);
    }

    function closeModal() {
        modal.style.opacity = '0';
        modal.querySelector('.modal-content').style.transform = 'scale(0.95)';
        setTimeout(() => modal.classList.add('hidden'), 250);
    }

    // --- NEW: Centralized API Error Handling ---
    async function displayError(element, response) {
        let message = "An unexpected error occurred. Please check the console for details.";
        try {
            const errorBody = await response.json();
            // Use the specific error message from the backend if available
            message = errorBody.detail || errorBody.error || JSON.stringify(errorBody);
        } catch (e) {
            // Fallback if the response body isn't valid JSON
            message = `Request failed with status: ${response.status} ${response.statusText}`;
        }

        if (element.id === 'report-content-container') {
            element.innerHTML = `<div class="p-6"><p class="text-red-500 font-semibold">An error occurred: ${message}</p></div>`;
        } else {
            element.textContent = `Error: ${message}`;
        }
    }

    // --- Chat Assistant UI ---
    const chatBtn = document.getElementById('chat-assistant-btn');
    const chatModal = document.getElementById('chat-modal');
    const closeChatBtn = document.getElementById('close-chat-btn');
    const chatInput = document.getElementById('chat-input');
    const chatSendBtn = document.getElementById('chat-send-btn');
    const chatMessages = document.getElementById('chat-messages');
    const chatLoading = document.getElementById('chat-loading');

    if (chatBtn) {
        chatBtn.addEventListener('click', () => {
            chatModal.classList.remove('hidden');
            setTimeout(() => {
                chatModal.style.opacity = '1';
                chatModal.querySelector('.chat-modal-content').style.transform = 'scale(1)';
            }, 10);
        });
    }

    if (closeChatBtn) {
        closeChatBtn.addEventListener('click', closeChatModal);
    }

    if (chatModal) {
        chatModal.addEventListener('click', (e) => {
            if (e.target === chatModal) closeChatModal();
        });
    }

    function closeChatModal() {
        if (chatModal) {
            chatModal.style.opacity = '0';
            chatModal.querySelector('.chat-modal-content').style.transform = 'scale(0.95)';
            setTimeout(() => chatModal.classList.add('hidden'), 250);
        }
    }

    function addChatMessage(text, isUser = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `p-3 rounded-lg mb-3 ${isUser ? 'bg-blue-500 text-white ml-12' : 'bg-gray-100 text-gray-800 mr-12'}`;
        messageDiv.textContent = text;
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    async function sendChatMessage() {
        const question = chatInput.value.trim();
        if (!question) return;

        // Add user message
        addChatMessage(question, true);
        chatInput.value = '';
        chatSendBtn.disabled = true;
        chatLoading.classList.remove('hidden');

        try {
            const response = await fetch('http://localhost:8000/chat', {
                method: 'POST',
                mode: 'cors',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ question })
            });

            if (!response.ok) {
                const errorData = await response.json();
                addChatMessage(`Error: ${errorData.detail || errorData.error || 'Failed to get response'}`);
                return;
            }

            const result = await response.json();
            addChatMessage(result.answer);

            // Show sources if available
            if (result.sources && result.sources.length > 0) {
                const sourcesDiv = document.createElement('div');
                sourcesDiv.className = 'mt-2 text-xs text-gray-500 italic';
                sourcesDiv.textContent = `Sources: ${result.sources.length} relevant section(s) found`;
                chatMessages.appendChild(sourcesDiv);
            }
        } catch (error) {
            addChatMessage(`Network error: ${error.message}. Make sure the FastAPI server is running on http://localhost:8000`);
        } finally {
            chatSendBtn.disabled = false;
            chatLoading.classList.add('hidden');
        }
    }

    if (chatSendBtn) {
        chatSendBtn.addEventListener('click', sendChatMessage);
    }

    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }
});