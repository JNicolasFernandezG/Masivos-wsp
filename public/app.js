const state = {
  adminToken: localStorage.getItem('masivos_admin_token') || '',
  authRequired: false,
  selectedBatchId: null,
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

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.adminToken) {
    headers.set('X-Admin-Token', state.adminToken);
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    state.authRequired = true;
    $('btn-auth-modal').classList.remove('hidden');
    $('auth-modal').classList.remove('hidden');
    throw new Error('Se requiere ADMIN_API_TOKEN válido.');
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
      state.unreadInbox = 0;
      $('inbox-badge').classList.add('hidden');
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
    if (health.config?.authRequired) {
      state.authRequired = true;
      $('btn-auth-modal').classList.remove('hidden');
    }
    if (health.config?.defaultCountryCode && !$('country-code').value) {
      $('country-code').value = health.config.defaultCountryCode;
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

  if (!worker.enabled) {
    pill.className = 'pill warn';
    txt.textContent = 'Deshabilitado';
    return;
  }
  if (worker.busy && worker.currentMessageId) {
    pill.className = 'pill ok';
    txt.textContent = `Enviando #${worker.currentMessageId}`;
    return;
  }
  if (worker.nextSendAt) {
    const remainingSec = Math.max(
      0,
      Math.ceil((new Date(worker.nextSendAt).getTime() - Date.now()) / 1000)
    );
    if (remainingSec > 0) {
      pill.className = 'pill ok';
      txt.textContent = `Pausa anti-baneo: ${remainingSec}s`;
      return;
    }
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
  $('preview-summary').textContent =
    `Válidos: ${preview.validCount} · Inválidos: ${preview.invalidCount} · Duración estimada (jitter 20–60s): ${formatSeconds(dur.min)} a ${formatSeconds(dur.max)}`;

  const table = $('preview-table');
  const tbody = table.querySelector('tbody');
  tbody.replaceChildren();

  for (const item of preview.items) {
    const tr = el('tr', {}, [
      el('td', { textContent: String(item.rowIndex) }),
      el('td', { textContent: item.recipientRaw || '-' }),
      el('td', {}, [el('code', { textContent: item.chatId || '-' })]),
      el('td', { textContent: item.renderedText || '-' }),
      el('td', {}, [
        el('span', {
          className: `status-tag ${item.valid ? 'status-ENVIADO' : 'status-ERROR'}`,
          textContent: item.valid ? 'Válido' : item.error || 'Error',
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
        rows: state.parsedRows,
      }),
    });

    showAlert(`Lote #${res.batch.id} ("${res.batch.name}") encolado con ${res.batch.total_count} mensajes.`, 'ok');
    state.selectedBatchId = res.batch.id;
    document.querySelector('.tab[data-tab="batches"]').click();
    await loadBatches();
  } catch (err) {
    showAlert(err.message, 'err');
  }
});

// --- Cola y Lotes ---
async function loadBatches() {
  try {
    const data = await apiFetch('/api/batches');
    updateWorkerPill(data.worker);
    renderBatchesList(data.batches || []);
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
          el('span', { className: `status-tag status-${b.status}`, textContent: b.status }),
        ]),
        el('div', {
          className: 'muted',
          textContent: `Enviados: ${b.sent_count}/${b.total_count} · Pendientes: ${b.pending_count} · Errores: ${b.error_count}`,
        }),
        el('div', { className: 'progress-bar' }, [
          el('div', { className: 'progress-fill', style: `width: ${pct}%` }),
        ]),
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
          textContent: 'Cancelar pendientes',
          onclick: () => batchAction(batch.id, 'cancel'),
        })
      );
    }

    const tbody = el('tbody');
    for (const m of messages) {
      tbody.appendChild(
        el('tr', {}, [
          el('td', { textContent: String(m.id) }),
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

$('btn-refresh-batches').addEventListener('click', loadBatches);

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

    if (conversations.length === 0) {
      list.replaceChildren(
        el('p', { className: 'muted', textContent: 'Aún no hay mensajes registrados.' })
      );
      return;
    }

    list.replaceChildren();
    for (const c of conversations) {
      const title = c.sender_name
        ? `${c.sender_name} (${c.sender_phone || c.chat_id})`
        : c.sender_phone || c.chat_id;
      const item = el(
        'div',
        {
          className: `conv-item ${state.selectedChatId === c.chat_id ? 'selected' : ''}`,
          onclick: () => selectConversation(c.chat_id),
        },
        [
          el('div', { className: 'card-header' }, [
            el('strong', { textContent: title }),
            el('span', { className: 'muted', textContent: formatDateTime(c.last_timestamp) }),
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

$('btn-refresh-inbox').addEventListener('click', loadConversations);
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
  } catch (err) {
    showAlert(err.message, 'err');
  }
});

// --- Tiempo real (SSE) ---
function connectSse() {
  if (state.eventSource) {
    state.eventSource.close();
  }
  const url = state.adminToken
    ? `/api/events?token=${encodeURIComponent(state.adminToken)}`
    : '/api/events';

  const es = new EventSource(url);
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
}

// --- Modal Admin Token ---
$('btn-auth-modal').addEventListener('click', () => {
  $('admin-token-input').value = state.adminToken;
  $('auth-modal').classList.remove('hidden');
});

$('btn-close-auth').addEventListener('click', () => {
  $('auth-modal').classList.add('hidden');
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.adminToken = $('admin-token-input').value.trim();
  localStorage.setItem('masivos_admin_token', state.adminToken);
  $('auth-modal').classList.add('hidden');
  hideAlert();
  connectSse();
  await refreshHealthAndWaha();
  await loadBatches();
});

// Inicialización
connectSse();
refreshHealthAndWaha();
loadBatches();
