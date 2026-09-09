// Quantum IPTV Custom In-App Alert & Confirmation Dialog System
// Replaces standard browser window.alert and window.confirm with beautiful glassmorphic modals

export interface DialogOptions {
  title?: string;
  type?: 'info' | 'success' | 'warning' | 'error' | 'danger';
  confirmText?: string;
  cancelText?: string;
}

let activeResolve: ((val: any) => void) | null = null;

function ensureDialogDOM(): HTMLElement {
  let modal = document.getElementById('modal-app-dialog');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-app-dialog';
    modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm z-[200] flex items-center justify-center p-4 hidden transition-opacity duration-200';
    modal.innerHTML = `
      <div id="app-dialog-card" class="bg-slate-900 border border-slate-800 rounded-2xl p-5 max-w-sm w-full shadow-2xl relative flex flex-col text-center items-center transition-transform duration-200 scale-95">
        <button id="app-dialog-btn-close" class="absolute top-3 right-3 text-slate-400 hover:text-white w-7 h-7 rounded-full bg-slate-800/70 flex items-center justify-center transition">
          <i class="fa-solid fa-xmark text-sm pointer-events-none"></i>
        </button>
        <div id="app-dialog-icon-wrap" class="w-12 h-12 rounded-2xl bg-brand-600/20 border border-brand-500/30 flex items-center justify-center text-brand-400 text-xl mb-3">
          <i id="app-dialog-icon" class="fa-solid fa-circle-info"></i>
        </div>
        <h3 id="app-dialog-title" class="text-base font-bold text-white tracking-tight mb-1">Notification</h3>
        <p id="app-dialog-message" class="text-xs text-slate-300 leading-relaxed mb-5 whitespace-pre-line max-h-60 overflow-y-auto w-full px-1"></p>
        <div id="app-dialog-actions" class="flex items-center justify-center gap-2.5 w-full">
          <button id="app-dialog-btn-cancel" class="hidden flex-1 py-2 px-3 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-xl transition">Cancel</button>
          <button id="app-dialog-btn-confirm" class="flex-1 py-2 px-3 bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold rounded-xl transition shadow-md shadow-brand-600/30">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Event listeners
    const btnClose = modal.querySelector('#app-dialog-btn-close');
    const btnCancel = modal.querySelector('#app-dialog-btn-cancel');
    const btnConfirm = modal.querySelector('#app-dialog-btn-confirm');

    btnClose?.addEventListener('click', () => closeAppDialog(false));
    btnCancel?.addEventListener('click', () => closeAppDialog(false));
    btnConfirm?.addEventListener('click', () => closeAppDialog(true));
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeAppDialog(false);
    });
  }
  return modal;
}

export function closeAppDialog(result: boolean = false): void {
  const modal = document.getElementById('modal-app-dialog');
  const card = document.getElementById('app-dialog-card');
  if (card) {
    card.classList.add('scale-95');
  }
  if (modal) {
    modal.classList.add('opacity-0');
    setTimeout(() => {
      modal.classList.add('hidden');
    }, 150);
  }
  if (activeResolve) {
    activeResolve(result);
    activeResolve = null;
  }
}

export function showAppAlert(message: string, options: DialogOptions = {}): Promise<void> {
  return new Promise((resolve) => {
    const modal = ensureDialogDOM();
    activeResolve = () => resolve();

    const titleEl = document.getElementById('app-dialog-title');
    const msgEl = document.getElementById('app-dialog-message');
    const iconWrap = document.getElementById('app-dialog-icon-wrap');
    const iconEl = document.getElementById('app-dialog-icon');
    const btnCancel = document.getElementById('app-dialog-btn-cancel');
    const btnConfirm = document.getElementById('app-dialog-btn-confirm');
    const card = document.getElementById('app-dialog-card');

    const type = options.type || 'info';
    const title = options.title || (type === 'error' ? 'Error' : type === 'warning' ? 'Warning' : type === 'success' ? 'Success' : 'Notice');

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;

    if (btnCancel) btnCancel.classList.add('hidden');
    if (btnConfirm) {
      btnConfirm.textContent = options.confirmText || 'OK';
      btnConfirm.className = 'flex-1 py-2 px-3 bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold rounded-xl transition shadow-md shadow-brand-600/30';
    }

    // Set icon & styling by type
    if (iconWrap && iconEl) {
      if (type === 'success') {
        iconWrap.className = 'w-12 h-12 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 text-xl mb-3';
        iconEl.className = 'fa-solid fa-circle-check';
      } else if (type === 'warning') {
        iconWrap.className = 'w-12 h-12 rounded-2xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center text-amber-400 text-xl mb-3';
        iconEl.className = 'fa-solid fa-triangle-exclamation';
      } else if (type === 'error' || type === 'danger') {
        iconWrap.className = 'w-12 h-12 rounded-2xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center text-rose-400 text-xl mb-3';
        iconEl.className = 'fa-solid fa-circle-exclamation';
      } else {
        iconWrap.className = 'w-12 h-12 rounded-2xl bg-brand-600/20 border border-brand-500/30 flex items-center justify-center text-brand-400 text-xl mb-3';
        iconEl.className = 'fa-solid fa-circle-info';
      }
    }

    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
      modal.classList.remove('opacity-0');
      if (card) card.classList.remove('scale-95');
    });
  });
}

export function showAppConfirm(message: string, options: DialogOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = ensureDialogDOM();
    activeResolve = (val: boolean) => resolve(val);

    const titleEl = document.getElementById('app-dialog-title');
    const msgEl = document.getElementById('app-dialog-message');
    const iconWrap = document.getElementById('app-dialog-icon-wrap');
    const iconEl = document.getElementById('app-dialog-icon');
    const btnCancel = document.getElementById('app-dialog-btn-cancel');
    const btnConfirm = document.getElementById('app-dialog-btn-confirm');
    const card = document.getElementById('app-dialog-card');

    const type = options.type || 'warning';
    const title = options.title || 'Confirm Action';

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;

    if (btnCancel) {
      btnCancel.classList.remove('hidden');
      btnCancel.textContent = options.cancelText || 'Cancel';
    }

    if (btnConfirm) {
      btnConfirm.textContent = options.confirmText || 'Confirm';
      if (type === 'danger' || type === 'error' || type === 'warning') {
        btnConfirm.className = 'flex-1 py-2 px-3 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-xl transition shadow-md shadow-rose-600/30';
      } else {
        btnConfirm.className = 'flex-1 py-2 px-3 bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold rounded-xl transition shadow-md shadow-brand-600/30';
      }
    }

    // Set icon & styling
    if (iconWrap && iconEl) {
      if (type === 'danger' || type === 'error') {
        iconWrap.className = 'w-12 h-12 rounded-2xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center text-rose-400 text-xl mb-3';
        iconEl.className = 'fa-solid fa-circle-exclamation';
      } else if (type === 'warning') {
        iconWrap.className = 'w-12 h-12 rounded-2xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center text-amber-400 text-xl mb-3';
        iconEl.className = 'fa-solid fa-triangle-exclamation';
      } else {
        iconWrap.className = 'w-12 h-12 rounded-2xl bg-brand-600/20 border border-brand-500/30 flex items-center justify-center text-brand-400 text-xl mb-3';
        iconEl.className = 'fa-solid fa-circle-question';
      }
    }

    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
      modal.classList.remove('opacity-0');
      if (card) card.classList.remove('scale-95');
    });
  });
}

// Global window registration and automatic fallback override
(window as any).showAppAlert = showAppAlert;
(window as any).showAppConfirm = showAppConfirm;
(window as any).closeAppDialog = closeAppDialog;

// Intercept window.alert and route to our in-app modal
window.alert = (message?: any) => {
  showAppAlert(String(message ?? ''));
};
