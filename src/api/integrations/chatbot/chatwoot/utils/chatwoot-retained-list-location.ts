import { boundedRetainedMetadata } from './chatwoot-retained-history-formats';

const object = (value: any): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, any>, fields: string[]) => Object.keys(value).every((key) => fields.includes(key));
const text = (value: any) => typeof value === 'string' && value.length <= 16384;
const optionalText = (value: any) => value === undefined || text(value);
const context = (value: any) => value === undefined || boundedRetainedMetadata(value);
const nativeLong = (value: any) =>
  (Number.isSafeInteger(value) && value >= 0) ||
  (object(value) &&
    only(value, ['low', 'high', 'unsigned']) &&
    Number.isInteger(value.low) &&
    value.low >= -2147483648 &&
    value.low <= 2147483647 &&
    Number.isInteger(value.high) &&
    value.high >= 0 &&
    value.high <= 2147483647 &&
    typeof value.unsigned === 'boolean');

/** Closed ordinary shapes already rendered by the stock history renderer; never execute list actions. */
export function isRetainedListOrLiveLocation(record: { messageType: string; message: unknown }): boolean {
  const body = record.message as any;
  if (
    !boundedRetainedMetadata(body) ||
    !only(body, [record.messageType, 'messageContextInfo']) ||
    !context(body.messageContextInfo) ||
    body.messageContextInfo?.stanzaId !== undefined
  )
    return false;
  const value = body[record.messageType];
  if (!object(value) || !context(value.contextInfo)) return false;
  if (record.messageType === 'liveLocationMessage') {
    const thumbnail = value.jpegThumbnail;
    return (
      only(value, ['degreesLatitude', 'degreesLongitude', 'sequenceNumber', 'jpegThumbnail', 'contextInfo']) &&
      typeof value.degreesLatitude === 'number' &&
      Number.isFinite(value.degreesLatitude) &&
      Math.abs(value.degreesLatitude) <= 90 &&
      typeof value.degreesLongitude === 'number' &&
      Number.isFinite(value.degreesLongitude) &&
      Math.abs(value.degreesLongitude) <= 180 &&
      (value.sequenceNumber === undefined || nativeLong(value.sequenceNumber)) &&
      (thumbnail === undefined ||
        (typeof thumbnail === 'string' &&
          Buffer.from(thumbnail, 'base64').toString('base64') === thumbnail &&
          Buffer.from(thumbnail, 'base64').length <= 16384))
    );
  }
  if (record.messageType === 'listMessage') {
    if (
      !only(value, ['title', 'description', 'buttonText', 'listType', 'sections', 'footerText', 'contextInfo']) ||
      value.listType !== 1 ||
      !['title', 'description', 'footerText'].every((key) => optionalText(value[key])) ||
      !text(value.buttonText) ||
      !value.buttonText.length ||
      !Array.isArray(value.sections) ||
      value.sections.length < 1 ||
      value.sections.length > 20
    )
      return false;
    const ids = new Set<string>();
    return value.sections.every(
      (section: any) =>
        object(section) &&
        only(section, ['title', 'rows']) &&
        optionalText(section.title) &&
        Array.isArray(section.rows) &&
        section.rows.length > 0 &&
        section.rows.length <= 100 &&
        section.rows.every((row: any) => {
          if (
            !object(row) ||
            !only(row, ['title', 'description', 'rowId']) ||
            !text(row.title) ||
            !row.title.length ||
            !optionalText(row.description) ||
            !text(row.rowId) ||
            !row.rowId.length ||
            ids.has(row.rowId) ||
            ids.size >= 200
          )
            return false;
          ids.add(row.rowId);
          return true;
        }),
    );
  }
  return (
    record.messageType === 'listResponseMessage' &&
    only(value, ['title', 'description', 'listType', 'singleSelectReply', 'contextInfo']) &&
    value.listType === 1 &&
    text(value.title) &&
    value.title.length > 0 &&
    optionalText(value.description) &&
    object(value.singleSelectReply) &&
    only(value.singleSelectReply, ['selectedRowId']) &&
    text(value.singleSelectReply.selectedRowId) &&
    value.singleSelectReply.selectedRowId.length > 0
  );
}
