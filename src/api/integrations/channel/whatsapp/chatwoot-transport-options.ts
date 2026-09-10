export interface BaileysTransportOptions {
  mentions?: string[];
  linkPreview?: boolean;
  quoted?: any;
  messageId?: string;
  ephemeralExpiration?: number;
  contextInfo?: any;
  beforeTransport?: () => Promise<void>;
  signal?: AbortSignal;
}

export const buildBaileysTransportOptions = (options: BaileysTransportOptions): BaileysTransportOptions => ({
  mentions: options.mentions,
  linkPreview: options.linkPreview,
  quoted: options.quoted,
  messageId: options.messageId,
  ephemeralExpiration: options.ephemeralExpiration,
  contextInfo: options.contextInfo,
  beforeTransport: options.beforeTransport,
  signal: options.signal,
});
