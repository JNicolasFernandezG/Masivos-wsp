const state = {
  authRequired: false,
  authenticated: false,
  selectedBatchId: null,
  batchesPage: 1,
  batchesLimit: 10,
  batchesPagination: null,
  selectedChatId: null,
  unreadInbox: 0,
  parsedRows: [],
  parsedHeaders: [],
  sourceMode: 'web_file',
  lastPreview: null,
  workerStatus: null,
  eventSource: null,
};

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') {
      node.className = v;
    } else if (k === 'textContent') {
      node.textContent = v;
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== undefined && v !== null) {
      node.setAttribute(k, String(v));
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (typeof child === 'string') {
      node.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      node.appendChild(child);
    }
  }
  return node;
}

function showAlert(message, type = 'info') {
  const box = $('global-alert');
  box.textContent = message;
  box.className = `alert ${type}`;
  if (type === 'ok' || type === 'info') {
    setTimeout(() => {
      if (box.textContent === message) {
        box.classList.add('hidden');
      }
    }, 5000);
  }
}

function hideAlert() {
  $('global-alert').classList.add('hidden');
}

function showLoginScreen(errorMessage = '') {
  state.authenticated = false;
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  $('status-bar').classList.add('hidden');
  $('app-nav').classList.add('hidden');
  $('app-main').classList.add('hidden');
  $('login-screen').classList.remove('hidden');

  const errBox = $('login-error');
  if (errorMessage) {
    errBox.textContent = errorMessage;
    errBox.classList.remove('hidden');
  } else {
    errBox.classList.add('hidden');
  }
  $('login-password').focus();
}

function showWorkspace(authRequired) {
  state.authenticated = true;
  state.authRequired = authRequired;
  $('login-screen').classList.add('hidden');
  $('status-bar').classList.remove('hidden');
  $('app-nav').classList.remove('hidden');
  $('app-main').classList.remove('hidden');
  if (authRequired) {
    $('btn-logout').classList.remove('hidden');
  } else {
    $('btn-logout').classList.add('hidden');
  }
}

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    state.authRequired = true;
    showLoginScreen('Tu sesión expiró o requiere iniciar sesión.');
    throw new Error('No autorizado.');
  }

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const errMsg =
      typeof data === 'object' && data && data.error
        ? data.error
        : `Error HTTP ${res.status}`;
    const err = new Error(errMsg);
    err.payload = data;
    throw err;
  }
  return data;
}

function formatDateTime(isoOrUnix) {
  if (!isoOrUnix) return '-';
  const date =
    typeof isoOrUnix === 'number'
      ? new Date(isoOrUnix * 1000)
      : new Date(isoOrUnix);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatSeconds(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

// --- Navegación de pestañas ---
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tabId = btn.getAttribute('data-tab');
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${tabId}`).classList.add('active');

    if (tabId === 'inbox') {
      loadConversations();
    } else if (tabId === 'waha') {
      loadWahaSession();
    } else if (tabId === 'batches') {
      loadBatches();
    }
  });
});

// --- Estado global / Worker / WAHA ---
async function refreshHealthAndWaha() {
  try {
    const health = await apiFetch('/api/health');
    if (health.config?.defaultCountryCode !== undefined) {
      $('country-code').value = health.config.defaultCountryCode;
    }
    if (health.config?.defaultMessageTemplate && !$('template-input').value.trim()) {
      $('template-input').value = health.config.defaultMessageTemplate;
    }
    updateWorkerPill(health.worker);
  } catch (err) {
    $('worker-status-text').textContent = 'Error';
  }

  try {
    await loadWahaSession();
  } catch {
    // Handled inside loadWahaSession
  }
}

function updateWorkerPill(worker) {
  if (!worker) return;
  state.workerStatus = worker;
  const pill = $('pill-worker');
  const txt = $('worker-status-text');
  const dailyPill = $('pill-daily');
  const dailyTxt = $('daily-status-text');

  if (dailyTxt) {
    const sent = worker.sentToday ?? 0;
    const limit = worker.dailyLimit ?? 125;
    const win = worker.businessHoursWindow ? ` · ${worker.businessHoursWindow}` : '';
    dailyTxt.textContent = `${sent}/${limit}${win}`;
    dailyPill.className = sent >= limit ? 'pill warn' : 'pill ok';
  }

  const pauseAllBtn = $('btn-pause-all-batches');
  const resumeAllBtn = $('btn-resume-all-batches');
  if (pauseAllBtn && resumeAllBtn) {
    const isPaused = Boolean(worker.manualPaused || worker.pauseReason === 'MANUAL_PAUSE');
    pauseAllBtn.disabled = !worker.enabled || isPaused;
    resumeAllBtn.disabled = !worker.enabled || !isPaused;
  }

  if (!worker.enabled) {
    pill.className = 'pill warn';
    txt.textContent = 'Deshabilitado';
    return;
  }
  if (worker.manualPaused || worker.pauseReason === 'MANUAL_PAUSE') {
    pill.className = 'pill warn';
    txt.textContent = worker.busy ? 'Pausando tras envío actual...' : 'Pausado manualmente';
    return;
  }
  if (worker.busy && worker.currentMessageId) {
    pill.className = 'pill ok';
    txt.textContent = `Enviando #${worker.currentMessageId}`;
    return;
  }

  const remainingSec = worker.nextSendAt
    ? Math.max(0, Math.ceil((new Date(worker.nextSendAt).getTime() - Date.now()) / 1000))
    : 0;

  if (worker.pauseReason === 'OUTSIDE_HOURS' || worker.pauseReason === 'NON_BUSINESS_DAY') {
    pill.className = 'pill warn';
    const nextStr = worker.nextSendAt ? formatDateTime(worker.nextSendAt) : 'próximo horario';
    txt.textContent = `Fuera de horario (retoma ${nextStr})`;
    return;
  }
  if (worker.pauseReason === 'DAILY_LIMIT_REACHED') {
    pill.className = 'pill warn';
    txt.textContent = `Tope diario (${worker.sentToday}/${worker.dailyLimit})`;
    return;
  }
  if (worker.pauseReason === 'CHUNK_PAUSE' && remainingSec > 0) {
    pill.className = 'pill warn';
    txt.textContent = `Pausa entre tandas: ${formatSeconds(remainingSec)}`;
    return;
  }
  if (worker.pauseReason === 'SESSION_NOT_READY') {
    pill.className = 'pill warn';
    txt.textContent = `Esperando sesión (${worker.sessionStatus})`;
    return;
  }
  if (worker.pauseReason === 'SESSION_WARMUP' && remainingSec > 0) {
    pill.className = 'pill warn';
    txt.textContent = `Espera post-conexión: ${formatSeconds(remainingSec)}`;
    return;
  }
  if (remainingSec > 0) {
    pill.className = 'pill ok';
    txt.textContent = `Pausa anti-baneo: ${remainingSec}s`;
    return;
  }
  pill.className = worker.running ? 'pill ok' : 'pill warn';
  txt.textContent = worker.running ? 'Activo (en espera)' : 'Detenido';
}

setInterval(() => {
  if (state.workerStatus?.nextSendAt) {
    updateWorkerPill(state.workerStatus);
  }
}, 1000);

async function loadWahaSession() {
  const pill = $('pill-waha');
  const txt = $('waha-status-text');
  const details = $('waha-details');

  try {
    const data = await apiFetch('/api/waha/session');
    const status = data.session?.status || 'UNKNOWN';
    txt.textContent = status;

    if (status === 'WORKING') {
      pill.className = 'pill ok';
    } else if (status === 'SCAN_QR_CODE' || status === 'STARTING') {
      pill.className = 'pill warn';
    } else {
      pill.className = 'pill err';
    }

    details.replaceChildren(
      el('div', { className: 'muted', textContent: 'Sesión:' }),
      el('div', { textContent: data.sessionName || '-' }),
      el('div', { className: 'muted', textContent: 'Estado:' }),
      el('div', { textContent: status }),
      el('div', { className: 'muted', textContent: 'Motor:' }),
      el('div', { textContent: data.session?.engine || 'GOWS' }),
      el('div', { className: 'muted', textContent: 'Cuenta:' }),
      el('div', {
        textContent: data.session?.me?.id
          ? `${data.session.me.pushName || ''} (${data.session.me.id})`
          : 'Sin vincular',
      })
    );
  } catch (err) {
    pill.className = 'pill err';
    txt.textContent = 'Sin conexión';
    details.replaceChildren(
      el('div', { className: 'muted', textContent: 'Error:' }),
      el('div', { textContent: err.message })
    );
  }
}

$('btn-waha-start').addEventListener('click', async () => {
  try {
    await apiFetch('/api/waha/session/start', { method: 'POST' });
    showAlert('Sesión iniciada en WAHA.', 'ok');
    await loadWahaSession();
  } catch (err) {
    showAlert(err.message, 'err');
  }
});

$('btn-waha-stop').addEventListener('click', async () => {
  try {
    await apiFetch('/api/waha/session/stop', { method: 'POST' });
    showAlert('Sesión detenida.', 'info');
    await loadWahaSession();
  } catch (err) {
    showAlert(err.message, 'err');
  }
});

$('btn-waha-restart').addEventListener('click', async () => {
  try {
    await apiFetch('/api/waha/session/restart', { method: 'POST' });
    showAlert('Sesión reiniciada.', 'info');
    await loadWahaSession();
  } catch (err) {
    showAlert(err.message, 'err');
  }
});

$('btn-waha-logout').addEventListener('click', async () => {
  if (!confirm('¿Desvincular este dispositivo de WhatsApp?')) return;
  try {
    await apiFetch('/api/waha/session/logout', { method: 'POST' });
    showAlert('Sesión desvinculada.', 'warn');
    $('qr-container').replaceChildren(
      el('p', { className: 'muted', textContent: 'Sesión cerrada.' })
    );
    await loadWahaSession();
  } catch (err) {
    showAlert(err.message, 'err');
  }
});

$('btn-waha-qr').addEventListener('click', async () => {
  const container = $('qr-container');
  container.replaceChildren(el('p', { className: 'muted', textContent: 'Obteniendo QR...' }));
  try {
    const qr = await apiFetch('/api/waha/qr');
    const img = el('img', {
      src: `data:${qr.mimetype};base64,${qr.data}`,
      alt: 'Código QR WhatsApp WAHA',
    });
    container.replaceChildren(img);
  } catch (err) {
    container.replaceChildren(el('p', { className: 'muted', textContent: err.message }));
  }
});

$('pairing-code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = $('pairing-phone').value.trim();
  if (!phone) return;
  try {
    const res = await apiFetch('/api/waha/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: phone }),
    });
    $('pairing-code-result').replaceChildren(
      el('div', {
        className: 'alert ok',
        textContent: `Código de vinculación: ${res.code || 'Enviado'}`,
      })
    );
  } catch (err) {
    $('pairing-code-result').replaceChildren(
      el('div', { className: 'alert err', textContent: err.message })
    );
  }
});

// --- Carga y previsualización de lotes ---
$('btn-mode-file').addEventListener('click', () => {
  state.sourceMode = 'web_file';
  $('btn-mode-file').className = 'btn btn-sm btn-primary';
  $('btn-mode-manual').className = 'btn btn-sm btn-secondary';
  $('panel-mode-file').classList.remove('hidden');
  $('panel-mode-manual').classList.add('hidden');
});

$('btn-mode-manual').addEventListener('click', () => {
  state.sourceMode = 'web_manual';
  $('btn-mode-manual').className = 'btn btn-sm btn-primary';
  $('btn-mode-file').className = 'btn btn-sm btn-secondary';
  $('panel-mode-manual').classList.remove('hidden');
  $('panel-mode-file').classList.add('hidden');
});

function populateColumns(parsed) {
  state.parsedHeaders = parsed.headers || [];
  state.parsedRows = parsed.rows || [];
  state.lastPreview = null;
  $('btn-submit-batch').disabled = true;

  const phoneSelect = $('phone-column');
  const textSelect = $('text-column');
  phoneSelect.replaceChildren();
  textSelect.replaceChildren(el('option', { value: '', textContent: '-- Usar plantilla de abajo --' }));

  for (const header of state.parsedHeaders) {
    phoneSelect.appendChild(el('option', { value: header, textContent: header }));
    textSelect.appendChild(el('option', { value: header, textContent: header }));
  }

  if (parsed.suggestedPhoneColumn) {
    phoneSelect.value = parsed.suggestedPhoneColumn;
  }
  if (parsed.suggestedTextColumn && !$('template-input').value.trim()) {
    textSelect.value = parsed.suggestedTextColumn;
  }

  const chips = $('variable-chips');
  chips.replaceChildren();
  for (const header of state.parsedHeaders) {
    const chip = el('button', {
      type: 'button',
      className: 'chip',
      textContent: `{{${header}}}`,
      onclick: () => {
        const area = $('template-input');
        const token = `{{${header}}}`;
        const start = area.selectionStart ?? area.value.length;
        const end = area.selectionEnd ?? area.value.length;
        area.value = area.value.slice(0, start) + token + area.value.slice(end);
        area.focus();
      },
    });
    chips.appendChild(chip);
  }
}

$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  hideAlert();

  const formData = new FormData();
  formData.append('file', file);

  try {
    const parsed = await apiFetch('/api/batches/parse-file', {
      method: 'POST',
      body: formData,
    });
    populateColumns(parsed);
    $('file-info').textContent = `Cargado "${parsed.filename}": ${parsed.rows.length} fila(s), columnas: ${parsed.headers.join(', ')}`;
    if (!$('batch-name').value.trim()) {
      $('batch-name').value = parsed.filename.replace(/\.[^.]+$/, '');
    }
    showAlert(`Planilla "${parsed.filename}" leída con ${parsed.rows.length} fila(s).`, 'ok');
  } catch (err) {
    showAlert(err.message, 'err');
  }
});

$('btn-parse-manual').addEventListener('click', async () => {
  const text = $('manual-input').value.trim();
  if (!text) {
    showAlert('Pega primero los datos CSV con encabezado.', 'warn');
    return;
  }
  const blob = new Blob([text], { type: 'text/csv' });
  const formData = new FormData();
  formData.append('file', blob, 'manual.csv');

  try {
    const parsed = await apiFetch('/api/batches/parse-file', {
      method: 'POST',
      body: formData,
    });
    populateColumns(parsed);
    if (!$('batch-name').value.trim()) {
      $('batch-name').value = `Lote manual ${new Date().toLocaleTimeString('es-AR')}`;
    }
    showAlert(`Lista manual cargada: ${parsed.rows.length} fila(s).`, 'ok');
  } catch (err) {
    showAlert(err.message, 'err');
  }
});

$('btn-preview-batch').addEventListener('click', async () => {
  if (state.parsedRows.length === 0) {
    showAlert('Primero carga un archivo .xlsx/.csv o una lista manual.', 'warn');
    return;
  }

  try {
    const preview = await apiFetch('/api/batches/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: $('template-input').value,
        phoneColumn: $('phone-column').value,
        textColumn: $('text-column').value || undefined,
        defaultCountryCode: $('country-code').value.trim(),
        deduplicate: $('deduplicate-check').checked,
        rows: state.parsedRows,
      }),
    });

    state.lastPreview = preview;
    renderPreview(preview);
  } catch (err) {
    showAlert(err.message, 'err');
  }
});

function renderPreview(preview) {
  const warningsBox = $('preview-warnings');
  warningsBox.replaceChildren();
  for (const w of preview.warnings || []) {
    warningsBox.appendChild(el('div', { className: 'alert warn', textContent: w }));
  }

  const dur = preview.estimatedDurationSeconds;
  const daysText = preview.estimatedDays > 1 ? ` · Días estimados: ~${preview.estimatedDays}` : '';
  $('preview-summary').textContent =
    `Válidos: ${preview.validCount} (${preview.chunkCount} tanda/s de hasta ${preview.chunkSize}) · Duplicados omitidos: ${preview.duplicateCount} · Inválidos: ${preview.invalidCount} · Duración envío activo: ${formatSeconds(dur.min)} a ${formatSeconds(dur.max)}${daysText}`;

  const table = $('preview-table');
  const tbody = table.querySelector('tbody');
  tbody.replaceChildren();

  for (const item of preview.items) {
    const statusClass = item.valid
      ? item.warning
        ? 'status-PAUSADO'
        : 'status-ENVIADO'
      : item.duplicate
        ? 'status-CANCELADO'
        : 'status-ERROR';
    const statusText = item.valid
      ? item.warning || 'Válido'
      : item.duplicate
        ? 'Duplicado (omitido)'
        : item.error || 'Error';

    const tr = el('tr', {}, [
      el('td', { textContent: String(item.rowIndex) }),
      el('td', { textContent: item.chunkIndex ? `Tanda ${item.chunkIndex}` : '-' }),
      el('td', { textContent: item.recipientRaw || '-' }),
      el('td', {}, [el('code', { textContent: item.chatId || '-' })]),
      el('td', { textContent: item.renderedText || '-' }),
      el('td', {}, [
        el('span', {
          className: `status-tag ${statusClass}`,
          textContent: statusText,
        }),
      ]),
    ]);
    tbody.appendChild(tr);
  }

  table.classList.remove('hidden');
  const skipInvalid = $('skip-invalid-check').checked;
  $('btn-submit-batch').disabled =
    preview.validCount === 0 || (preview.invalidCount > 0 && !skipInvalid);
}

$('skip-invalid-check').addEventListener('change', () => {
  if (state.lastPreview) {
    renderPreview(state.lastPreview);
  }
});

$('deduplicate-check').addEventListener('change', () => {
  if (state.parsedRows.length > 0 && state.lastPreview) {
    $('btn-preview-batch').click();
  }
});

$('btn-submit-batch').addEventListener('click', async () => {
  const name = $('batch-name').value.trim() || `Lote ${new Date().toLocaleString('es-AR')}`;
  try {
    const res = await apiFetch('/api/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        source: state.sourceMode,
        template: $('template-input').value,
        phoneColumn: $('phone-column').value,
        textColumn: $('text-column').value || undefined,
        defaultCountryCode: $('country-code').value.trim(),
        skipInvalid: $('skip-invalid-check').checked,
        deduplicate: $('deduplicate-check').checked,
        rows: state.parsedRows,
      }),
    });

    showAlert(`Lote #${res.batch.id} ("${res.batch.name}") encolado con ${res.batch.total_count} mensajes.`, 'ok');
    state.selectedBatchId = res.batch.id;
    state.batchesPage = 1;
    document.querySelector('.tab[data-tab="batches"]').click();
    await loadBatches(1);
  } catch (err) {
    showAlert(err.message, 'err');
  }
});

// --- Cola y Lotes ---
function resetBatchDetailView() {
  state.selectedBatchId = null;
  $('batch-detail-title').textContent = 'Detalle del lote';
  $('batch-detail-actions').replaceChildren();
  $('batch-detail-content').replaceChildren(
    el('p', {
      className: 'muted',
      textContent: 'Selecciona un lote para inspeccionar el estado de cada envío.',
    })
  );
}

function buildPageNumbers(currentPage, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const pages = [1];
  const start = Math.max(2, currentPage - 1);
  const end = Math.min(totalPages - 1, currentPage + 1);
  if (start > 2) pages.push('...');
  for (let p = start; p <= end; p += 1) {
    pages.push(p);
  }
  if (end < totalPages - 1) pages.push('...');
  pages.push(totalPages);
  return pages;
}

function renderBatchesPagination(pagination) {
  const container = $('batches-pagination');
  if (!container) return;
  if (!pagination || pagination.total === 0 || pagination.totalPages <= 1) {
    container.classList.add('hidden');
    container.replaceChildren();
    return;
  }

  const { page, totalPages, total } = pagination;
  const buttons = el('div', { className: 'pagination-buttons' });

  buttons.appendChild(
    el('button', {
      type: 'button',
      className: 'page-btn',
      textContent: '‹',
      title: 'Página anterior',
      disabled: page <= 1 ? 'disabled' : null,
      onclick: () => loadBatches(page - 1),
    })
  );

  for (const item of buildPageNumbers(page, totalPages)) {
    if (item === '...') {
      buttons.appendChild(el('span', { className: 'page-ellipsis', textContent: '…' }));
    } else {
      buttons.appendChild(
        el('button', {
          type: 'button',
          className: `page-btn ${item === page ? 'active' : ''}`,
          textContent: String(item),
          onclick: () => {
            if (item !== page) loadBatches(item);
          },
        })
      );
    }
  }

  buttons.appendChild(
    el('button', {
      type: 'button',
      className: 'page-btn',
      textContent: '›',
      title: 'Página siguiente',
      disabled: page >= totalPages ? 'disabled' : null,
      onclick: () => loadBatches(page + 1),
    })
  );

  container.replaceChildren(
    el('span', {
      className: 'pagination-info',
      textContent: `Página ${page} de ${totalPages} · ${total} lote(s)`,
    }),
    buttons
  );
  container.classList.remove('hidden');
}

async function loadBatches(requestedPage = state.batchesPage) {
  try {
    const targetPage = Math.max(1, Number(requestedPage) || 1);
    const data = await apiFetch(
      `/api/batches?page=${targetPage}&limit=${state.batchesLimit}`
    );
    const batches = data.batches || [];
    const pagination = data.pagination || {
      page: 1,
      limit: state.batchesLimit,
      total: batches.length,
      totalPages: 1,
    };
    state.batchesPage = pagination.page;
    state.batchesPagination = pagination;

    updateWorkerPill(data.worker);
    if (pagination.total === 0 && state.selectedBatchId) {
      resetBatchDetailView();
    }
    renderBatchesList(batches);
    renderBatchesPagination(pagination);
    if (state.selectedBatchId) {
      await loadBatchDetail(state.selectedBatchId);
    }
  } catch (err) {
    $('batches-list').replaceChildren(
      el('p', { className: 'muted', textContent: err.message })
    );
  }
}

function renderBatchesList(batches) {
  const container = $('batches-list');
  if (batches.length === 0) {
    container.replaceChildren(
      el('p', { className: 'muted', textContent: 'No hay lotes cargados todavía.' })
    );
    return;
  }

  container.replaceChildren();
  for (const b of batches) {
    const done = b.sent_count + b.error_count + b.cancelled_count;
    const pct = b.total_count > 0 ? Math.round((done / b.total_count) * 100) : 0;
    const progressFill = el('div', { className: 'progress-fill' });
    progressFill.style.width = `${pct}%`;
    const card = el(
      'div',
      {
        className: `batch-item ${state.selectedBatchId === b.id ? 'selected' : ''}`,
        onclick: () => {
          state.selectedBatchId = b.id;
          renderBatchesList(batches);
          loadBatchDetail(b.id);
        },
      },
      [
        el('div', { className: 'card-header' }, [
          el('strong', { textContent: `#${b.id} · ${b.name}` }),
          el('div', { className: 'row gap-xs' }, [
            el('span', { className: `status-tag status-${b.status}`, textContent: b.status }),
            ...(b.pending_count > 0
              ? [
                  el('button', {
                    type: 'button',
                    className: 'btn btn-danger btn-sm',
                    textContent: 'Cancelar lote',
                    onclick: (e) => {
                      e.stopPropagation();
                      const ok = confirm(
                        `¿Cancelar los ${b.pending_count} envío(s) pendientes del lote #${b.id} (${b.name})?`
                      );
                      if (ok) {
                        batchAction(b.id, 'cancel');
                      }
                    },
                  }),
                ]
              : []),
          ]),
        ]),
        el('div', {
          className: 'muted',
          textContent: `Enviados: ${b.sent_count}/${b.total_count} · Pendientes: ${b.pending_count} · Errores: ${b.error_count}`,
        }),
        el('div', { className: 'progress-bar' }, [progressFill]),
      ]
    );
    container.appendChild(card);
  }
}

async function loadBatchDetail(batchId) {
  try {
    const { batch, messages } = await apiFetch(`/api/batches/${batchId}`);
    $('batch-detail-title').textContent = `Lote #${batch.id} · ${batch.name}`;

    const actions = $('batch-detail-actions');
    actions.replaceChildren();
    if (batch.status === 'PENDIENTE' || batch.status === 'EN_PROCESO') {
      actions.appendChild(
        el('button', {
          type: 'button',
          className: 'btn btn-secondary btn-sm',
          textContent: 'Pausar',
          onclick: () => batchAction(batch.id, 'pause'),
        })
      );
    }
    if (batch.status === 'PAUSADO') {
      actions.appendChild(
        el('button', {
          type: 'button',
          className: 'btn btn-primary btn-sm',
          textContent: 'Reanudar',
          onclick: () => batchAction(batch.id, 'resume'),
        })
      );
    }
    if (batch.error_count > 0) {
      actions.appendChild(
        el('button', {
          type: 'button',
          className: 'btn btn-secondary btn-sm',
          textContent: 'Reintentar errores',
          onclick: () => batchAction(batch.id, 'retry-failed'),
        })
      );
    }
    if (batch.pending_count > 0) {
      actions.appendChild(
        el('button', {
          type: 'button',
          className: 'btn btn-danger btn-sm',
          textContent: 'Cancelar lote',
          onclick: () => {
            const ok = confirm(
              `¿Cancelar los ${batch.pending_count} envío(s) pendientes del lote #${batch.id} (${batch.name})?`
            );
            if (ok) {
              batchAction(batch.id, 'cancel');
            }
          },
        })
      );
    }

    const tbody = el('tbody');
    for (const m of messages) {
      tbody.appendChild(
        el('tr', {}, [
          el('td', { textContent: String(m.id) }),
          el('td', { textContent: `T${m.chunk_index || 1}` }),
          el('td', {}, [el('code', { textContent: m.chat_id })]),
          el('td', { textContent: m.rendered_text }),
          el('td', {}, [
            el('span', { className: `status-tag status-${m.status}`, textContent: m.status }),
          ]),
          el('td', {
            className: 'muted',
            textContent: m.error_message || (m.sent_at ? formatDateTime(m.sent_at) : '-'),
          }),
        ])
      );
    }

    const table = el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { textContent: 'ID' }),
          el('th', { textContent: 'Tanda' }),
          el('th', { textContent: 'chatId' }),
          el('th', { textContent: 'Mensaje' }),
          el('th', { textContent: 'Estado' }),
          el('th', { textContent: 'Resultado' }),
        ]),
      ]),
      tbody,
    ]);

    $('batch-detail-content').replaceChildren(
      el('div', { className: 'table-wrap' }, [table])
    );
  } catch (err) {
    $('batch-detail-content').replaceChildren(
      el('p', { className: 'muted', textContent: err.message })
    );
  }
}

async function batchAction(batchId, action) {
  try {
    await apiFetch(`/api/batches/${batchId}/${action}`, { method: 'POST' });
    await loadBatches();
  } catch (err) {
    showAlert(err.message, 'err');
  }
}

$('btn-pause-all-batches').addEventListener('click', async () => {
  const btn = $('btn-pause-all-batches');
  btn.disabled = true;
  try {
    const data = await apiFetch('/api/worker/pause', { method: 'POST' });
    if (data.worker) {
      updateWorkerPill(data.worker);
    }
    showAlert('Envíos de lotes pausados manualmente.', 'info');
  } catch (err) {
    showAlert(err.message, 'err');
    btn.disabled = false;
  }
});

$('btn-resume-all-batches').addEventListener('click', async () => {
  const btn = $('btn-resume-all-batches');
  btn.disabled = true;
  try {
    const data = await apiFetch('/api/worker/resume', { method: 'POST' });
    if (data.worker) {
      updateWorkerPill(data.worker);
    }
    showAlert('Envíos de lotes reanudados.', 'ok');
  } catch (err) {
    showAlert(err.message, 'err');
    btn.disabled = false;
  }
});

$('btn-refresh-batches').addEventListener('click', () => loadBatches(state.batchesPage));

$('btn-clear-batches').addEventListener('click', async () => {
  const confirmed = confirm(
    '¿Eliminar todos los lotes finalizados (completados y cancelados) de la base de datos?\n\nLos lotes pendientes, en proceso o pausados se conservarán y la cuota diaria anti-baneo seguirá respetándose.'
  );
  if (!confirmed) return;

  const btn = $('btn-clear-batches');
  btn.disabled = true;
  try {
    const res = await apiFetch('/api/batches/history', { method: 'DELETE' });
    resetBatchDetailView();
    await loadBatches(1);
    if (res.deletedBatches === 0) {
      showAlert('No había lotes finalizados para limpiar.', 'info');
    } else {
      showAlert(
        `Historial limpiado: se eliminaron ${res.deletedBatches} lote(s) y ${res.deletedMessages} envío(s).`,
        'ok'
      );
    }
  } catch (err) {
    showAlert(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

// --- Inbox / Mensajes entrantes y respuestas ---
async function loadConversations() {
  try {
    const search = $('inbox-search').value.trim();
    if (search) {
      const data = await apiFetch(
        `/api/messages?search=${encodeURIComponent(search)}&limit=100`
      );
      renderSearchMessages(data.messages || []);
      return;
    }

    const data = await apiFetch('/api/conversations');
    const list = $('conversations-list');
    const conversations = data.conversations || [];

    const unansweredCount = conversations.filter((c) => c.last_direction === 'IN').length;
    state.unreadInbox = unansweredCount;
    const badge = $('inbox-badge');
    if (unansweredCount > 0) {
      badge.textContent = String(unansweredCount);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    if (conversations.length === 0) {
      list.replaceChildren(
        el('p', { className: 'muted', textContent: 'Aún no hay mensajes registrados.' })
      );
      return;
    }

    list.replaceChildren();
    for (const c of conversations) {
      const isUnanswered = c.last_direction === 'IN';
      const title = c.sender_name
        ? `${c.sender_name} (${c.sender_phone || c.chat_id})`
        : c.sender_phone || c.chat_id;
      const item = el(
        'div',
        {
          className: `conv-item ${isUnanswered ? 'unanswered' : ''} ${state.selectedChatId === c.chat_id ? 'selected' : ''}`.trim(),
          onclick: () => selectConversation(c.chat_id),
        },
        [
          el('div', { className: 'card-header' }, [
            el('strong', { textContent: title }),
            el('div', { className: 'row gap-xs' }, [
              ...(isUnanswered
                ? [el('span', { className: 'unanswered-tag', textContent: 'Sin responder' })]
                : []),
              el('span', { className: 'muted', textContent: formatDateTime(c.last_timestamp) }),
            ]),
          ]),
          el('div', {
            className: 'muted',
            textContent: `${c.last_direction === 'OUT' ? 'Tú: ' : ''}${c.last_body || '[Multimedia]'}`,
          }),
        ]
      );
      list.appendChild(item);
    }
  } catch (err) {
    $('conversations-list').replaceChildren(
      el('p', { className: 'muted', textContent: err.message })
    );
  }
}

function renderSearchMessages(messages) {
  const list = $('conversations-list');
  if (messages.length === 0) {
    list.replaceChildren(el('p', { className: 'muted', textContent: 'Sin coincidencias.' }));
    return;
  }
  list.replaceChildren();
  for (const m of messages) {
    list.appendChild(
      el(
        'div',
        {
          className: 'conv-item',
          onclick: () => selectConversation(m.chat_id),
        },
        [
          el('div', { className: 'card-header' }, [
            el('strong', { textContent: m.sender_name || m.chat_id }),
            el('span', { className: 'muted', textContent: formatDateTime(m.timestamp_unix) }),
          ]),
          el('div', { className: 'muted', textContent: m.body || '[Multimedia]' }),
        ]
      )
    );
  }
}

async function selectConversation(chatId) {
  state.selectedChatId = chatId;
  $('reply-chat-id').value = chatId;
  $('chat-title').textContent = `Chat: ${chatId}`;
  $('chat-subtitle').textContent = 'Mensajes sincronizados vía webhook WAHA (GOWS).';

  try {
    const data = await apiFetch(
      `/api/messages?chatId=${encodeURIComponent(chatId)}&limit=150`
    );
    const messages = [...(data.messages || [])].reverse();
    const stream = $('chat-messages');
    stream.replaceChildren();

    for (const m of messages) {
      const originInfo =
        m.raw_chat_id && m.raw_chat_id !== m.chat_id ? ` · origen ${m.raw_chat_id}` : '';
      const metaText = `${m.direction === 'IN' ? m.sender_name || m.chat_id : 'Enviado'} · ${formatDateTime(m.timestamp_unix)}${originInfo}`;
      stream.appendChild(
        el('div', { className: `msg-bubble ${m.direction}` }, [
          el('div', { className: 'msg-meta', textContent: metaText }),
          el('div', { textContent: m.body || `[${m.message_type}]` }),
        ])
      );
    }
    stream.scrollTop = stream.scrollHeight;
  } catch (err) {
    showAlert(err.message, 'err');
  }

  loadConversations();
}

function resetChatView() {
  state.selectedChatId = null;
  state.unreadInbox = 0;
  $('inbox-badge').classList.add('hidden');
  $('chat-title').textContent = 'Historial de mensajes';
  $('chat-subtitle').textContent =
    'Selecciona una conversación para ver mensajes y responder.';
  $('chat-messages').replaceChildren(
    el('p', { className: 'muted', textContent: 'Sin conversación seleccionada.' })
  );
}

async function syncWahaMessages({ silent = false } = {}) {
  const btn = $('btn-sync-inbox');
  if (btn) btn.disabled = true;
  try {
    const res = await apiFetch('/api/messages/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatLimit: 30, messagesPerChat: 20 }),
    });
    if (res.synced) {
      await loadConversations();
      if (state.selectedChatId) {
        await selectConversation(state.selectedChatId);
      }
      if (!silent) {
        showAlert(
          res.importedCount > 0
            ? `Sincronización completada: se importaron ${res.importedCount} mensaje(s) de ${res.chatsScanned} chat(s).`
            : `Sincronización completada (${res.chatsScanned} chat(s) revisados, sin mensajes nuevos).`,
          'ok'
        );
      }
    } else if (!silent) {
      showAlert(
        `No se pudo sincronizar: sesión WhatsApp en estado ${res.sessionStatus}.`,
        'info'
      );
    }
  } catch (err) {
    if (!silent) {
      showAlert(err.message, 'err');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

$('btn-sync-inbox').addEventListener('click', () => syncWahaMessages({ silent: false }));
$('btn-refresh-inbox').addEventListener('click', loadConversations);

$('btn-clear-messages').addEventListener('click', async () => {
  const confirmed = confirm(
    '¿Eliminar todo el historial de mensajes y conversaciones almacenados en la base de datos? Esta acción no se puede deshacer.'
  );
  if (!confirmed) return;

  const btn = $('btn-clear-messages');
  btn.disabled = true;
  try {
    const res = await apiFetch('/api/messages/history', { method: 'DELETE' });
    resetChatView();
    await loadConversations();
    if (res.deletedMessages === 0) {
      showAlert('No había mensajes en el historial para limpiar.', 'info');
    } else {
      showAlert(`Se eliminaron ${res.deletedMessages} mensaje(s) del historial.`, 'ok');
    }
  } catch (err) {
    showAlert(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});
$('inbox-search').addEventListener('input', () => {
  loadConversations();
});

$('reply-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const chatId = $('reply-chat-id').value.trim();
  const text = $('reply-text').value.trim();
  if (!chatId || !text) return;

  try {
    const res = await apiFetch('/api/messages/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, text }),
    });
    $('reply-text').value = '';
    const resolvedChatId = res.message?.chat_id || chatId;
    await selectConversation(resolvedChatId);
    await loadConversations();
  } catch (err) {
    showAlert(err.message, 'err');
  }
});

// --- Tiempo real (SSE) ---
function connectSse() {
  if (state.eventSource) {
    state.eventSource.close();
  }
  const es = new EventSource('/api/events');
  state.eventSource = es;

  es.addEventListener('connected', () => {
    $('pill-sse').className = 'pill ok';
    $('sse-status-text').textContent = 'Conectado';
  });

  es.onerror = () => {
    $('pill-sse').className = 'pill warn';
    $('sse-status-text').textContent = 'Reconectando...';
  };

  es.addEventListener('worker.status', (ev) => {
    const parsed = JSON.parse(ev.data);
    updateWorkerPill(parsed.data);
  });

  es.addEventListener('session.status', () => {
    loadWahaSession();
  });

  es.addEventListener('batch.updated', (ev) => {
    const parsed = JSON.parse(ev.data);
    loadBatches();
    if (state.selectedBatchId && parsed.data?.id === state.selectedBatchId) {
      loadBatchDetail(state.selectedBatchId);
    }
  });

  es.addEventListener('batches.cleared', () => {
    resetBatchDetailView();
    loadBatches(1);
  });

  es.addEventListener('outbound.updated', (ev) => {
    const parsed = JSON.parse(ev.data);
    if (state.selectedBatchId && parsed.data?.batch_id === state.selectedBatchId) {
      loadBatchDetail(state.selectedBatchId);
    }
  });

  es.addEventListener('message.received', (ev) => {
    const parsed = JSON.parse(ev.data);
    const activeTab = document.querySelector('.tab.active')?.getAttribute('data-tab');
    if (activeTab !== 'inbox') {
      state.unreadInbox += 1;
      const badge = $('inbox-badge');
      badge.textContent = String(state.unreadInbox);
      badge.classList.remove('hidden');
    } else {
      loadConversations();
      if (state.selectedChatId && parsed.data?.chat_id === state.selectedChatId) {
        selectConversation(state.selectedChatId);
      }
    }
  });

  es.addEventListener('message.sent', (ev) => {
    const parsed = JSON.parse(ev.data);
    const activeTab = document.querySelector('.tab.active')?.getAttribute('data-tab');
    if (activeTab === 'inbox') {
      loadConversations();
      if (state.selectedChatId && parsed.data?.chat_id === state.selectedChatId) {
        selectConversation(state.selectedChatId);
      }
    }
  });

  es.addEventListener('messages.cleared', () => {
    resetChatView();
    const activeTab = document.querySelector('.tab.active')?.getAttribute('data-tab');
    if (activeTab === 'inbox') {
      loadConversations();
    }
  });
}

// --- Login y cierre de sesión ---
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('login-password').value;
  const errBox = $('login-error');
  const submitBtn = $('btn-login-submit');
  errBox.classList.add('hidden');
  submitBtn.disabled = true;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errBox.textContent = data?.error || 'Clave incorrecta.';
      errBox.classList.remove('hidden');
      $('login-password').select();
      return;
    }

    $('login-password').value = '';
    showWorkspace(Boolean(data.authRequired));
    connectSse();
    await refreshHealthAndWaha();
    await loadBatches();
    syncWahaMessages({ silent: true });
  } catch {
    errBox.textContent = 'No se pudo conectar con el servidor.';
    errBox.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
  }
});

$('btn-logout').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    // Ignore network error on logout
  }
  showLoginScreen('');
});

function consumeSsoErrorFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('sso_error');
  if (!code) return '';

  window.history.replaceState({}, '', window.location.pathname || '/');
  switch (code) {
    case 'expired':
      return 'El enlace de acceso SSO expiró. Vuelve a abrir la app desde el portal de origen.';
    case 'used':
      return 'El enlace de acceso SSO ya fue utilizado. Genera un nuevo acceso desde el portal de origen.';
    case 'disabled':
      return 'El acceso SSO no está habilitado en este servidor.';
    case 'rate_limited':
      return 'Demasiados intentos de acceso SSO fallidos. Espera unos minutos e intenta nuevamente.';
    default:
      return 'El enlace de acceso SSO es inválido. Vuelve a ingresar desde el portal de origen.';
  }
}

async function initApp() {
  const ssoError = consumeSsoErrorFromUrl();
  try {
    const res = await fetch('/api/auth/status');
    const auth = await res.json();
    if (auth.authRequired && !auth.authenticated) {
      showLoginScreen(ssoError);
      return;
    }
    showWorkspace(Boolean(auth.authRequired));
    connectSse();
    await refreshHealthAndWaha();
    await loadBatches();
    syncWahaMessages({ silent: true });
  } catch {
    showWorkspace(false);
    connectSse();
    refreshHealthAndWaha();
    loadBatches();
    syncWahaMessages({ silent: true });
  }
}

initApp();
