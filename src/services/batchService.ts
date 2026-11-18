import type { AppConfig } from '../config.js';
import type { NewOutboundItem } from '../repositories/batchRepository.js';
import { normalizeOutboundRecipient } from './jidNormalizer.js';
import { analyzeMessageVariety, renderTemplate } from './templateRenderer.js';

export interface PreviewBatchItem {
  rowIndex: number;
  recipientRaw: string;
  phoneNormalized: string | null;
  chatId: string | null;
  renderedText: string;
  variables: Record<string, string>;
  missingVariables: string[];
  valid: boolean;
  error: string | null;
}

export interface BatchPreviewResult {
  items: PreviewBatchItem[];
  validItems: NewOutboundItem[];
  validCount: number;
  invalidCount: number;
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

export function prepareBatchPreview(params: PrepareBatchParams): BatchPreviewResult {
  const {
    rows,
    phoneColumn,
    textColumn,
    template = '',
    defaultCountryCode,
    config,
  } = params;

  const effectiveCountryCode =
    defaultCountryCode !== undefined ? defaultCountryCode : config.defaultCountryCode;
  const trimmedTemplate = template.trim();

  const items: PreviewBatchItem[] = [];
  const validItems: NewOutboundItem[] = [];
  const missingVarSet = new Set<string>();

  rows.forEach((rawRow, idx) => {
    const rowVariables = toStringRecord(rawRow);
    const rawRecipient =
      (phoneColumn ? rowVariables[phoneColumn] : undefined) ??
      rowVariables.to ??
      rowVariables.chatId ??
      rowVariables.telefono ??
      rowVariables.phone ??
      rowVariables.celular ??
      '';

    const recipientResult = normalizeOutboundRecipient(
      rawRecipient,
      effectiveCountryCode
    );

    let renderedText = '';
    let missingVariables: string[] = [];

    if (trimmedTemplate) {
      const rendered = renderTemplate(trimmedTemplate, rowVariables);
      renderedText = rendered.renderedText;
      missingVariables = rendered.missingKeys;
      for (const mv of missingVariables) {
        missingVarSet.add(mv);
      }
    } else {
      renderedText =
        (textColumn ? rowVariables[textColumn] : undefined) ??
        rowVariables.text ??
        rowVariables.mensaje ??
        rowVariables.texto ??
        rowVariables.message ??
        '';
      renderedText = renderedText.trim();
    }

    let error: string | null = null;
    if (!recipientResult.ok) {
      error = recipientResult.error;
    } else if (!renderedText) {
      error = 'El mensaje final está vacío.';
    }

    const valid = recipientResult.ok && error === null;
    const chatId = recipientResult.ok ? recipientResult.chatId : null;
    const phoneNormalized = recipientResult.ok ? recipientResult.phoneNormalized : null;

    items.push({
      rowIndex: idx + 1,
      recipientRaw: rawRecipient,
      phoneNormalized,
      chatId,
      renderedText,
      variables: rowVariables,
      missingVariables,
      valid,
      error,
    });

    if (valid && chatId) {
      validItems.push({
        recipientRaw: rawRecipient,
        phoneNormalized,
        chatId,
        variables: rowVariables,
        renderedText,
      });
    }
  });

  const warnings: string[] = [];
  const validCount = validItems.length;
  const invalidCount = items.length - validCount;

  if (validCount > config.workerSuggestedBatchSize) {
    warnings.push(
      `El lote tiene ${validCount} destinatarios válidos. Por seguridad anti-baneo se recomiendan lotes de hasta ~${config.workerSuggestedBatchSize} mensajes.`
    );
  }
  if (validCount > config.workerMaxBatchSize) {
    warnings.push(
      `Supera el límite máximo configurado (${config.workerMaxBatchSize} mensajes por lote).`
    );
  }

  const variety = analyzeMessageVariety(validItems.map((i) => i.renderedText));
  if (variety.allIdentical) {
    warnings.push(
      'Todos los mensajes del lote son idénticos. Conviene personalizar con variables (ej. {{nombre}}, {{nro_gestion}}) para reducir riesgo de spam.'
    );
  }

  if (missingVarSet.size > 0) {
    warnings.push(
      `Faltan valores en algunas filas para las variables: ${Array.from(missingVarSet).join(', ')}.`
    );
  }

  const gaps = Math.max(0, validCount - 1);
  const estimatedDurationSeconds = {
    min: Math.round((gaps * config.workerMinDelayMs) / 1000),
    max: Math.round((gaps * config.workerMaxDelayMs) / 1000),
  };

  return {
    items,
    validItems,
    validCount,
    invalidCount,
    warnings,
    estimatedDurationSeconds,
  };
}
