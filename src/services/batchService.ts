import type { AppConfig } from '../config.js';
import type { NewOutboundItem } from '../repositories/batchRepository.js';
import { normalizeOutboundRecipient } from './jidNormalizer.js';
import {
  analyzeMessageVariety,
  extractTemplateVariables,
  pickRandomTemplateVariant,
  renderTemplate,
  splitTemplateVariants,
} from './templateRenderer.js';

export interface PreviewBatchItem {
  rowIndex: number;
  chunkIndex: number | null;
  recipientRaw: string;
  phoneNormalized: string | null;
  chatId: string | null;
  renderedText: string;
  variables: Record<string, string>;
  missingVariables: string[];
  duplicate: boolean;
  warning: string | null;
  valid: boolean;
  error: string | null;
}

export interface BatchPreviewResult {
  items: PreviewBatchItem[];
  validItems: NewOutboundItem[];
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  chunkCount: number;
  chunkSize: number;
  estimatedDays: number;
  effectiveTemplate: string | null;
  warnings: string[];
  estimatedDurationSeconds: {
    min: number;
    max: number;
  };
}

export interface PrepareBatchParams {
  rows: Record<string, unknown>[];
  phoneColumn?: string;
  textColumn?: string;
  template?: string;
  defaultCountryCode?: string;
  deduplicate?: boolean;
  config: AppConfig;
}

function toStringRecord(raw: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) {
      result[k] = '';
    } else if (typeof v === 'object') {
      result[k] = JSON.stringify(v);
    } else {
      result[k] = String(v).trim();
    }
  }
  return result;
}

function findValueCaseInsensitive(
  record: Record<string, string>,
  candidates: string[]
): string | undefined {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(record)) {
    map.set(k.trim().toLowerCase(), v);
  }
  for (const cand of candidates) {
    if (map.has(cand)) {
      return map.get(cand);
    }
  }
  return undefined;
}

export function prepareBatchPreview(params: PrepareBatchParams): BatchPreviewResult {
  const {
    rows,
    phoneColumn,
    textColumn,
    template = '',
    defaultCountryCode,
    deduplicate = true,
    config,
  } = params;

  const effectiveCountryCode =
    defaultCountryCode !== undefined ? defaultCountryCode : config.defaultCountryCode;

  const hasExplicitTextColumn = Boolean(textColumn?.trim());
  const usesRowDirectText =
    !template.trim() &&
    (hasExplicitTextColumn ||
      rows.some((r) => {
        const str = toStringRecord(r);
        return Boolean(
          findValueCaseInsensitive(str, ['text', 'mensaje', 'texto', 'message', 'body'])
        );
      }));

  const effectiveTemplate = usesRowDirectText
    ? ''
    : template.trim() || config.defaultMessageTemplate;

  const templateVariants = effectiveTemplate ? splitTemplateVariants(effectiveTemplate) : [];
  const requiredVars = effectiveTemplate
    ? extractTemplateVariables(effectiveTemplate).map((v) => v.toLowerCase())
    : [];
  const requiresNombre = requiredVars.includes('nombre');

  const items: PreviewBatchItem[] = [];
  const validItems: NewOutboundItem[] = [];
  const seenChatIds = new Set<string>();
  const missingVarSet = new Set<string>();
  let duplicateCount = 0;
  let normalizationWarnings = 0;
  let lastVariantIndex: number | null = null;

  rows.forEach((rawRow, idx) => {
    const rowVariables = toStringRecord(rawRow);
    const rawRecipient =
      (phoneColumn ? rowVariables[phoneColumn] : undefined) ??
      findValueCaseInsensitive(rowVariables, [
        'to',
        'chatid',
        'chat_id',
        'telefono',
        'teléfono',
        'phone',
        'celular',
        'cel',
        'whatsapp',
        'numero',
        'número',
      ]) ??
      '';

    const recipientResult = normalizeOutboundRecipient(
      rawRecipient,
      effectiveCountryCode
    );

    let renderedText = '';
    let missingVariables: string[] = [];

    if (effectiveTemplate) {
      const picked = pickRandomTemplateVariant(templateVariants, lastVariantIndex);
      lastVariantIndex = picked.index;
      const rendered = renderTemplate(picked.variant || effectiveTemplate, rowVariables);
      renderedText = rendered.renderedText;
      missingVariables = rendered.missingKeys;
      for (const mv of missingVariables) {
        missingVarSet.add(mv);
      }
    } else {
      renderedText =
        (textColumn ? rowVariables[textColumn] : undefined) ??
        findValueCaseInsensitive(rowVariables, ['text', 'mensaje', 'texto', 'message', 'body']) ??
        '';
      renderedText = renderedText.trim();
    }

    const nombreVal = findValueCaseInsensitive(rowVariables, ['nombre', 'name', 'cliente']);
    let error: string | null = null;
    let duplicate = false;
    let warning: string | null = null;

    if (!recipientResult.ok) {
      error = recipientResult.error;
    } else {
      if (recipientResult.warning) {
        warning = recipientResult.warning;
        normalizationWarnings += 1;
      }
      if (requiresNombre && !nombreVal?.trim()) {
        error = 'Falta el valor de NOMBRE para armar el mensaje.';
      } else if (!renderedText) {
        error = 'El mensaje final está vacío.';
      } else if (deduplicate && seenChatIds.has(recipientResult.chatId)) {
        duplicate = true;
        duplicateCount += 1;
        warning = 'Teléfono duplicado en este archivo (omitido).';
      }
    }

    const valid = recipientResult.ok && error === null && !duplicate;
    const chatId = recipientResult.ok ? recipientResult.chatId : null;
    const phoneNormalized = recipientResult.ok ? recipientResult.phoneNormalized : null;

    let chunkIndex: number | null = null;
    if (valid && chatId) {
      seenChatIds.add(chatId);
      chunkIndex = Math.floor(validItems.length / config.workerChunkSize) + 1;
      validItems.push({
        chunkIndex,
        recipientRaw: rawRecipient,
        phoneNormalized,
        chatId,
        variables: rowVariables,
        renderedText,
      });
    }

    items.push({
      rowIndex: idx + 1,
      chunkIndex,
      recipientRaw: rawRecipient,
      phoneNormalized,
      chatId,
      renderedText,
      variables: rowVariables,
      missingVariables,
      duplicate,
      warning,
      valid,
      error,
    });
  });

  const warnings: string[] = [];
  const validCount = validItems.length;
  const invalidCount = items.filter((i) => !i.valid && !i.duplicate).length;
  const chunkCount = validCount > 0 ? Math.ceil(validCount / config.workerChunkSize) : 0;
  const estimatedDays =
    validCount > 0 ? Math.ceil(validCount / config.workerDailyLimit) : 0;

  if (chunkCount > 1) {
    const pauseMin = Math.round(config.workerChunkPauseMaxMs / 60000);
    warnings.push(
      `El envío se dividirá automáticamente en ${chunkCount} tandas de hasta ${config.workerChunkSize} mensajes, con pausa de hasta ${pauseMin} min entre tandas, tope de ${config.workerDailyLimit}/día y solo en horario comercial (${config.businessHoursStart}–${config.businessHoursEnd}).`
    );
  }

  if (validCount > config.workerMaxBatchSize) {
    warnings.push(
      `Supera el límite máximo permitido por carga (${config.workerMaxBatchSize} mensajes).`
    );
  }

  if (duplicateCount > 0) {
    warnings.push(
      `Se detectaron y omitieron ${duplicateCount} teléfono(s) duplicado(s) dentro del archivo.`
    );
  }

  if (normalizationWarnings > 0) {
    warnings.push(
      `Se aplicaron ${normalizationWarnings} corrección(es) automática(s) de prefijo telefónico; revisa la columna chatId en la tabla.`
    );
  }

  const variety = analyzeMessageVariety(validItems.map((i) => i.renderedText));
  if (variety.allIdentical) {
    warnings.push(
      'Todos los mensajes del lote son idénticos. Conviene personalizar con {{nombre}} para reducir riesgo de spam.'
    );
  }

  if (missingVarSet.size > 0) {
    warnings.push(
      `Faltan valores en algunas filas para las variables: ${Array.from(missingVarSet).join(', ')}.`
    );
  }

  const intraChunkGaps = Math.max(0, validCount - chunkCount);
  const interChunkGaps = Math.max(0, chunkCount - 1);
  const estimatedDurationSeconds = {
    min: Math.round(
      (intraChunkGaps * config.workerMinDelayMs +
        interChunkGaps * config.workerChunkPauseMinMs) /
        1000
    ),
    max: Math.round(
      (intraChunkGaps * config.workerMaxDelayMs +
        interChunkGaps * config.workerChunkPauseMaxMs) /
        1000
    ),
  };

  return {
    items,
    validItems,
    validCount,
    invalidCount,
    duplicateCount,
    chunkCount,
    chunkSize: config.workerChunkSize,
    estimatedDays,
    effectiveTemplate: effectiveTemplate || null,
    warnings,
    estimatedDurationSeconds,
  };
}
