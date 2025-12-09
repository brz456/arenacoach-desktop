// Skill Capped Verification Module
class SkillCappedVerifyUI {
    constructor() {
        this.isAuthenticated = false;
        this.isSkillCapped = false;
        this.setupElements();
        this.setupEvents();
        this.updateButtonState();
    }

    setupElements() {
        this.verifyBtn = document.getElementById('skillcapped-verify-btn');
        this.verifyBtnLabel = this.verifyBtn?.querySelector('.filter-label');
        this.verifyBtnIcon = this.verifyBtn?.querySelector('.filter-icon');
        this.modal = null;
    }

    setupEvents() {
        this.verifyBtn?.addEventListener('click', async () => {
            if (!this.isAuthenticated) {
                // Show toast when not logged in
                NotificationManager.show('Please log in with Battle.net first', 'info');
                return;
            }
            
            if (this.isSkillCapped) {
                // Already verified - just show confirmation
                NotificationManager.show('Your Skill Capped account is already verified!', 'success');
                return;
            }
            
            // Disable button and show loading state during check
            const originalText = this.verifyBtnLabel?.textContent || 'Verify Skill Capped';
            const wasDisabled = this.verifyBtn.disabled;
            this.verifyBtn.disabled = true;
            this.verifyBtn.setAttribute('aria-busy', 'true');
            if (this.verifyBtnLabel) {
                this.verifyBtnLabel.textContent = 'Checking...';
            }
            
            // Check server for current Skill Capped status
            let isVerifiedOnServer = false;
            try {
                const statusResult = await window.arenaCoach.auth.getSkillCappedStatus();
                
                if (statusResult.success && statusResult.verified) {
                    // Server confirms already verified
                    isVerifiedOnServer = true;
                    // The main process will emit auth:success which updates UI state
                    // We just show the notification here
                    NotificationManager.show('Your Skill Capped account is already verified!', 'success');
                } else {
                    // Not verified on server - show verification modal
                    this.showVerificationModal();
                }
            } catch (error) {
                console.error('Failed to check Skill Capped status:', error);
                // On error, assume not verified and show modal for user to verify
                this.showVerificationModal();
            } finally {
                // Only restore button state if not verified on server
                // This prevents flicker when auth:success is about to update the button
                if (!isVerifiedOnServer && !this.isSkillCapped) {
                    this.verifyBtn.disabled = wasDisabled;
                    this.verifyBtn.removeAttribute('aria-busy');
                    if (this.verifyBtnLabel) {
                        this.verifyBtnLabel.textContent = originalText;
                    }
                } else if (isVerifiedOnServer) {
                    // Remove aria-busy for verified state (auth:success will handle the rest)
                    this.verifyBtn.removeAttribute('aria-busy');
                }
                // If verified, auth:success event will update the button
            }
        });
    }

    updateButtonState() {
        // Get current auth state from AuthUI
        const authUI = window.app?.renderer?.authUI;
        this.isAuthenticated = !!authUI?.isAuthenticated;
        this.isSkillCapped = !!authUI?.currentUser?.is_skill_capped_verified;

        if (!this.verifyBtn) return;

        if (!this.isAuthenticated) {
            // Not logged in state - button still clickable to show toast
            this.verifyBtn.disabled = false;
            this.verifyBtn.title = 'Log in with Battle.net to verify';
            if (this.verifyBtnLabel) {
                this.verifyBtnLabel.textContent = 'Verify Skill Capped';
            }
            this.verifyBtn.classList.remove('verified');
        } else if (this.isSkillCapped) {
            // Verified state - green text
            this.verifyBtn.disabled = false;
            this.verifyBtn.title = 'Skill Capped Account Verified';
            if (this.verifyBtnLabel) {
                this.verifyBtnLabel.textContent = 'Skill Capped Verified!';
            }
            this.verifyBtn.classList.add('verified');
        } else {
            // Ready to verify state
            this.verifyBtn.disabled = false;
            this.verifyBtn.title = 'Click to verify your Skill Capped account';
            if (this.verifyBtnLabel) {
                this.verifyBtnLabel.textContent = 'Verify Skill Capped';
            }
            this.verifyBtn.classList.remove('verified');
        }
    }

    showVerificationModal() {
        // Remove existing modal if any
        if (this.modal) {
            this.modal.remove();
        }

        // Use unified modal structure (same as delete confirmation)
        this.modal = document.createElement('div');
        this.modal.className = 'app-modal';

        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';

        const dialog = document.createElement('div');
        dialog.className = 'modal-dialog';

        const title = document.createElement('h3');
        title.textContent = 'Verify Skill Capped Account';

        const instructions = document.createElement('p');
        instructions.textContent = 'Enter your Skill Capped verification code:';

        // Code input (uses unified modal-dialog input styles)
        const codeInput = document.createElement('input');
        codeInput.type = 'text';
        codeInput.placeholder = 'Enter verification code';
        codeInput.style.marginTop = '8px';

        // "Don't have a code?" help text with link
        const helpText = document.createElement('p');
        helpText.className = 'modal-help-text';
        const helpLink = document.createElement('a');
        helpLink.href = '#';
        helpLink.textContent = 'Subscribe on Skill-Capped';
        helpLink.addEventListener('click', (e) => {
            e.preventDefault();
            window.arenaCoach.window.openExternal('https://www.skill-capped.com/wow/pricing/plans#arenacoach');
        });
        helpText.appendChild(document.createTextNode("Don't have a code? "));
        helpText.appendChild(helpLink);

        // Error message container (only visible when there's an error)
        const errorMsg = document.createElement('div');
        errorMsg.className = 'modal-error';

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => this.closeModal());

        const verifyBtn = document.createElement('button');
        verifyBtn.className = 'btn';
        verifyBtn.textContent = 'Verify';
        verifyBtn.addEventListener('click', async () => {
            const code = codeInput.value.trim();
            if (!code) {
                errorMsg.textContent = 'Please enter a verification code';
                return;
            }

            // Disable form while submitting
            codeInput.disabled = true;
            verifyBtn.disabled = true;
            verifyBtn.textContent = 'Verifying...';
            errorMsg.textContent = '';

            try {
                // Call IPC to verify
                const result = await window.arenaCoach.auth.verifySkillCapped(code);

                if (result.success) {
                    // Success! Close modal immediately
                    this.closeModal();

                    // Show success notification
                    NotificationManager.show('Skill Capped account verified successfully!', 'success');

                    // The auth:success event from main.ts will handle:
                    // - Updating AuthUI state
                    // - Updating button states
                    // - Refreshing UI components
                    // This prevents duplicate updates and notifications
                } else {
                    // Show error
                    errorMsg.textContent = result.error || 'Verification failed. Please check your code.';
                    codeInput.disabled = false;
                    verifyBtn.disabled = false;
                    verifyBtn.textContent = 'Verify';
                }
            } catch (error) {
                console.error('Verification error:', error);
                errorMsg.textContent = 'An error occurred. Please try again.';
                codeInput.disabled = false;
                verifyBtn.disabled = false;
                verifyBtn.textContent = 'Verify';
            }
        });

        // Enter key support
        codeInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !verifyBtn.disabled) {
                verifyBtn.click();
            }
        });

        // Close on backdrop click
        backdrop.addEventListener('click', () => this.closeModal());

        actions.append(cancelBtn, verifyBtn);
        dialog.append(title, instructions, codeInput, helpText, errorMsg, actions);
        this.modal.append(backdrop, dialog);

        document.body.appendChild(this.modal);

        // Focus input
        codeInput.focus();
    }

    closeModal() {
        if (this.modal) {
            this.modal.remove();
            this.modal = null;
        }
    }

    // Called when auth state changes
    onAuthStateChange() {
        this.updateButtonState();
    }
}