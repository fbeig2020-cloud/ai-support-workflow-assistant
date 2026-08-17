/**
 * Command Center — generic drill-down modal widget.
 * Knows nothing about tabs or project data; app.js supplies title/body HTML.
 */
(function () {
  let modalEl = null;

  function close() {
    if (modalEl) modalEl.classList.remove('open');
  }

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'cc-modal-backdrop';
    modalEl.innerHTML = `
      <div class="cc-modal" role="dialog" aria-modal="true">
        <button type="button" class="cc-modal-close" aria-label="Close detail view">&times;</button>
        <div class="cc-modal-title"></div>
        <div class="cc-modal-body"></div>
      </div>
    `;
    document.body.appendChild(modalEl);
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) close();
    });
    modalEl.querySelector('.cc-modal-close').addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
    return modalEl;
  }

  function open(titleHtml, bodyHtml) {
    const el = ensureModal();
    el.querySelector('.cc-modal-title').innerHTML = titleHtml;
    el.querySelector('.cc-modal-body').innerHTML = bodyHtml;
    el.classList.add('open');
    el.querySelector('.cc-modal-close').focus();
  }

  window.CommandCenterModal = { open, close };
})();
