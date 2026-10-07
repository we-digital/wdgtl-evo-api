import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { InstanceDto } from '@api/dto/instance.dto';
import { Options, Quoted, SendAudioDto, SendMediaDto, SendTextDto } from '@api/dto/sendMessage.dto';
import { resolveChatwootAttachmentMetadata } from '@api/integrations/channel/whatsapp/media-message-metadata';
import { persistNativeForwardMessage } from '@api/integrations/channel/whatsapp/persist-native-forward-message';
import {
  ChatwootDto,
  ChatwootHistoryMappingReconcileDto,
  ChatwootHistoryRecoveryBatchDto,
  ChatwootHistorySyncBatchDto,
  ChatwootHistorySyncDto,
} from '@api/integrations/chatbot/chatwoot/dto/chatwoot.dto';
import { postgresClient } from '@api/integrations/chatbot/chatwoot/libs/postgres.client';
import {
  buildChatwootOutboundProvenance,
  validateChatwootAutoReplyBinding,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-auto-reply-binding';
import { classifyCachedHistoryRecord } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-cached-history-record';
import {
  CACHED_MEDIA_FILE_LIMIT,
  cachedHistoryMediaType,
  cachedMediaMIMEsEqual,
  nativeCachedMediaPayload,
  prepareCachedRecoveryMedia,
  readRetainedRecoveryMedia,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-cached-media';
import { withCanonicalChatwootMessageBinding } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-canonical-message-binding';
import {
  buildWhatsappGroupParticipantSnapshots,
  extractWhatsappMentionJids,
  formatIncomingWhatsappMentions,
  stripWhatsappMentionMarkdown,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-channel-mentions';
import { extractChatwootContacts } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-contact-sync';
import {
  buildChatwootDeliveryFailureUpdate,
  buildChatwootDeliverySuccessUpdate,
  ChatwootProviderContext,
  ChatwootProviderDeliveryPart,
  isChatwootDeliveryFailureAcknowledged,
  isChatwootMessageDeletion,
  isChatwootMessageEdit,
  isChatwootNativeArchiveProbe,
  isChatwootNativeMuteProbe,
  isChatwootNativePinProbe,
  isChatwootProviderDeliveryAcknowledged,
  isDeliverableChatwootOutgoing,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-delivery-status';
import { recoverEncryptedHistoryEdit } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-encrypted-history-edit';
import { formatWhatsappGroupContent } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-group-display';
import { preserveAlbumContainers } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-history-album';
import { reconcileHistoryMessageBinding } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-history-message-binding';
import {
  buildStoredLidMap,
  chatwootInboxCacheKey,
  dedupeHistoryMessagesBySourceId,
  historyRecoveryDestination,
  isGroupJid,
  isLidJid,
  isPhoneJid,
  matchesHistoryRecoveryDestination,
  normalizeStoredHistoryMessages,
  prepareStoredHistoryRecoveryMessage,
  resolveProviderClientContext,
  selectUniqueChatwootInbox,
  toCanonicalHistoryJid,
  toChatwootSourceId,
  uniqueHistoryRecoveryInboxId,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-history-sync';
import {
  acquireFullHistoryCapacity,
  acquireHistoryWriter,
  enqueueIncrementalHistorySync,
  tryAcquireHistoryWriter,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-history-sync-coordinator';
import {
  assertIgnoredEditOriginalIdentity,
  captureMissingEncryptedEditOriginal,
  captureMissingPlaintextEditOriginal,
  CONFLICTING_TEXT_EDIT_REJECTION,
  IGNORED_HISTORY_EDIT_REASON,
  ignoredHistoryEditFailure,
  IgnoredHistoryEditKind,
  IgnoredMissingEncryptedOriginalProof,
  IgnoredMissingPlaintextOriginalProof,
  IgnoredNullEditProof,
  ignoredNullEditProof,
  isUnavailableNullEditOriginal,
  UNAVAILABLE_ORIGINAL_EDIT_REASON,
  UnavailableOriginalEditProof,
  UnavailableOriginalEditState,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ignored-history-edit';
import { chatwootImport } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import {
  ChatwootIngressDeliveryFence,
  chatwootIngressDeliveryKey,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-delivery-fence';
import {
  buildChatwootEvoRouteBinding,
  buildChatwootIngressAttributes,
  ChatwootEvoRouteBinding,
  chatwootEvoRouteBindingsEqual,
  extractChatwootIngressMentionJids,
  isChatwootLinkedClientSentEvent,
  selectChatwootPhysicalReceiverNumber,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-ingress-scope';
import {
  getExactChatwootMessage,
  isChatwootOutgoingMessageType,
  unwrapChatwootPayload,
  updateChatwootMessageJson,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-message-api';
import {
  resolveNativeChatProbeId,
  shouldAttemptNativeForward,
  whatsappIdFromSourceId,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-native-guards';
import {
  chatwootOutboundContactIdentity,
  chatwootOutboundDestination,
  validatesCurrentChatwootOutboundSnapshot,
  validatesLocalChatwootDeletionBinding,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-binding';
import { ChatwootOutboundPrismaStore } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-prisma-store';
import {
  buildChatwootOutboundParts,
  ChatwootOutboundOrigin,
  ChatwootOutboundPhase,
  ChatwootOutboundQueue,
  StoredChatwootOutboundOperation,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-queue';
import {
  ChatwootOutboundWebhookHeaders,
  verifyChatwootOutboundWebhook,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-outbound-webhook-auth';
import { confirmProviderDeletionBeforeDroppingMapping } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-provider-deletion';
import { resolveWhatsappReactionKey } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-reaction-key';
import {
  buildWhatsappReactionActor,
  isAgentReactionWebhook,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-reactions';
import { buildExternalReadRequest } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-read-state';
import {
  chatwootReplyReferences,
  compactReplyToIds,
  extractWhatsappReplyStanzaId,
  toChatwootWhatsappSourceId,
  whatsappQuotedMessageContent,
  whatsappReplyQuoteSnapshotText,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-reply-context';
import {
  readRetainedChatwootGroupVideo,
  RetainedChatwootVideo,
  retainedVideoProxyUrl,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-retained-chatwoot-video';
import { readRetainedGroupMedia } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-retained-group-media';
import {
  retainedHistoryDisplayBody,
  retainedHistoryMedia,
  retainedTemplate,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-retained-history-formats';
import {
  requireTrustedChatwootUrl,
  resolveTrustedChatwootBaseUrl,
} from '@api/integrations/chatbot/chatwoot/utils/chatwoot-trusted-egress';
import { readStoredFile } from '@api/integrations/storage/s3/libs/minio.server';
import { PrismaRepository } from '@api/repository/repository.service';
import { CacheService } from '@api/services/cache.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import {
  isChatwootOutboundEcho,
  isRetainedChatwootOutboundMessageId,
  OutboundMessageProvenance,
} from '@api/types/outbound-provenance';
import { Events } from '@api/types/wa.types';
import { Chatwoot, ConfigService, Database, HttpServer } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException } from '@exceptions';
import ChatwootClient, {
  ChatwootAPIConfig,
  contact,
  contact_inboxes,
  conversation,
  conversation_show,
  generic_id,
  inbox,
} from '@figuro/chatwoot-sdk';
import { request as chatwootRequest } from '@figuro/chatwoot-sdk/dist/core/request';
import { Chatwoot as ChatwootModel, Contact as ContactModel, Message as MessageModel } from '@prisma/client';
import { formatCaughtError } from '@utils/formatCaughtError';
import i18next from '@utils/i18n';
import { sendTelemetry } from '@utils/sendTelemetry';
import axios from 'axios';
import { WAMessageContent, WAMessageKey } from 'baileys';
import dayjs from 'dayjs';
import FormData from 'form-data';
import { Jimp, JimpMime } from 'jimp';
import Long from 'long';
import mimeTypes from 'mime-types';
import path from 'path';
import { Readable } from 'stream';

interface ChatwootMessage {
  messageId?: number;
  inboxId?: number;
  conversationId?: number;
  contactInboxSourceId?: string;
  isRead?: boolean;
}

interface ChatwootClientContext {
  client: ChatwootClient;
  provider: ChatwootModel;
}

interface AuthenticatedChatwootClientContext extends ChatwootClientContext {
  instance: InstanceDto;
}

// Chatwoot's Channel::Api uses Rails has_secure_token, whose default token
// length is 24 characters. Accept that production shape without weakening the
// HMAC contract to arbitrary non-empty values.
const CHATWOOT_WEBHOOK_SECRET_MIN_LENGTH = 24;

let groupSyncActive = 0;
const groupSyncWaiters: Array<() => void> = [];
const scheduledGroupSyncs = new Set<string>();
const pendingGroupSyncs = new Map<string, string[] | undefined>();
const groupSyncs = new Map<string, Promise<any>>();

export class ChatwootService {
  private readonly logger = new Logger('ChatwootService');
  private readonly extendedHistorySyncKey = 'chatwoot:extendedHistorySync';
  private readonly historySyncCheckpointKey = 'chatwoot:historySyncCheckpoint';
  private readonly outboundStore: ChatwootOutboundPrismaStore;
  private readonly outboundQueue: ChatwootOutboundQueue;
  private readonly inboundDeliveryFence = new ChatwootIngressDeliveryFence();

  // Lock polling delay
  private readonly LOCK_POLLING_DELAY_MS = 300; // Delay between lock status checks

  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly configService: ConfigService,
    private readonly prismaRepository: PrismaRepository,
    private readonly cache: CacheService,
  ) {
    const outboundConfig = this.configService.get<Chatwoot>('CHATWOOT');
    this.outboundStore = new ChatwootOutboundPrismaStore(prismaRepository, {
      maxWait: Math.max(500, Math.min(30_000, outboundConfig.OUTBOUND_ADMISSION_MAX_WAIT_MS)),
      timeout: Math.max(1_000, Math.min(60_000, outboundConfig.OUTBOUND_ADMISSION_TIMEOUT_MS)),
    });
    this.outboundQueue = new ChatwootOutboundQueue(
      this.outboundStore,
      {
        prepare: (operation, signal) => this.prepareQueuedOutbound(operation, signal),
        validate: (operation, phase, signal) => this.validateOutboundBinding(operation, phase, signal),
        revalidateTransport: (operation, signal) => this.revalidateQueuedOutboundTransport(operation, signal),
        isReady: (operation, context, signal) => this.isOutboundReady(operation, context, signal),
        send: (operation, context, onTransportStart, signal) =>
          this.sendQueuedOutbound(operation, context, onTransportStart, signal),
        confirm: (operation, callbackParts, signal) => this.confirmQueuedOutbound(operation, callbackParts, signal),
        fail: (operation, signal) => this.failQueuedOutbound(operation, signal),
        delete: (operation, signal) => this.deleteQueuedOutbound(operation, signal),
        observe: (event, metrics) => this.logger.verbose(JSON.stringify({ event, ...metrics })),
      },
      1_000,
      600_000,
      undefined,
      {
        transport: Math.max(1, Math.min(16, outboundConfig.OUTBOUND_TRANSPORT_CONCURRENCY)),
        maintenance: Math.max(1, Math.min(8, outboundConfig.OUTBOUND_MAINTENANCE_CONCURRENCY)),
      },
    );
  }

  public async startOutboundWorker() {
    if (!this.configService.get<Chatwoot>('CHATWOOT').OUTBOUND_ASYNC_ENABLED) return;
    await this.bootstrapOutboundWebhookSecrets();
    await this.outboundQueue.start();
  }

  private async bootstrapOutboundWebhookSecrets() {
    const providers = await this.prismaRepository.chatwoot.findMany({
      where: { enabled: true, webhookSecret: null },
      select: { instanceId: true },
    });
    for (const provider of providers) {
      const stored = await this.prismaRepository.instance.findUnique({
        where: { id: provider.instanceId },
        select: { id: true, name: true },
      });
      if (!stored) continue;
      try {
        const inbox = await this.getInbox({ instanceId: stored.id, instanceName: stored.name }, false);
        const webhookSecret = (inbox as any)?.secret;
        if (typeof webhookSecret === 'string' && webhookSecret.length >= CHATWOOT_WEBHOOK_SECRET_MIN_LENGTH) {
          await this.prismaRepository.chatwoot.update({
            where: { instanceId: stored.id },
            data: { webhookSecret },
          });
          await this.cache.deleteAll(stored.name);
        } else {
          this.logger.error(JSON.stringify({ event: 'chatwoot_outbound_webhook_secret_bootstrap_failed' }));
        }
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: 'chatwoot_outbound_webhook_secret_bootstrap_failed',
            errorClass: error instanceof Error ? error.name : 'Error',
          }),
        );
      }
    }
  }

  public async stopOutboundWorker() {
    await this.outboundQueue.stop();
  }

  public async authenticateOutboundWebhook(
    instanceName: string,
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<ChatwootOutboundWebhookHeaders | undefined> {
    const config = this.configService.get<Chatwoot>('CHATWOOT');
    if (!config.OUTBOUND_ASYNC_ENABLED) return undefined;
    const instance = await this.prismaRepository.instance.findUnique({
      where: { name: instanceName },
      select: { id: true },
    });
    const provider = instance
      ? await this.prismaRepository.chatwoot.findUnique({ where: { instanceId: instance.id } })
      : null;
    if (!provider?.enabled) {
      throw Object.assign(new Error('Chatwoot webhook route is unavailable'), {
        name: 'ChatwootWebhookRouteUnavailable',
        status: 404,
      });
    }
    const verified = verifyChatwootOutboundWebhook({
      rawBody,
      headers,
      secrets: {
        current: provider.webhookSecret || '',
        previous: provider.webhookPreviousSecret,
        previousValidUntil: provider.webhookPreviousSecretValidUntil,
      },
      maxAgeMs: config.OUTBOUND_WEBHOOK_MAX_AGE_MS,
      maxBodyBytes: config.OUTBOUND_WEBHOOK_MAX_BODY_BYTES,
    });
    return { ...verified, routeInstanceId: instance.id, routeProviderId: provider.id };
  }

  private pgClient = postgresClient.getChatwootConnection();

  private async getProvider(instance: InstanceDto): Promise<ChatwootModel | null> {
    const cacheKey = `${instance.instanceName}:getProvider`;
    if (await this.cache.has(cacheKey)) {
      const provider = (await this.cache.get(cacheKey)) as ChatwootModel;

      return provider;
    }

    const provider = await this.waMonitor.waInstances[instance.instanceName]?.findChatwoot();

    if (!provider) {
      this.logger.warn('provider not found');
      return null;
    }

    this.cache.set(cacheKey, provider);

    return provider;
  }

  private async clientCw(instance: InstanceDto): Promise<ChatwootClientContext | null> {
    return resolveProviderClientContext(
      () => this.getProvider(instance),
      (provider) =>
        new ChatwootClient({
          config: this.getClientCwConfig(provider),
        }),
    );
  }

  private async authenticatedClientCw(
    instance: InstanceDto,
    admission: ChatwootOutboundWebhookHeaders,
  ): Promise<AuthenticatedChatwootClientContext | null> {
    if (!admission.routeInstanceId || !admission.routeProviderId) return null;
    const storedInstance = await this.prismaRepository.instance.findUnique({
      where: { id: admission.routeInstanceId },
      select: { id: true, name: true, ownerJid: true, number: true },
    });
    if (!storedInstance || storedInstance.name !== instance.instanceName) return null;
    const provider = await this.prismaRepository.chatwoot.findUnique({ where: { instanceId: storedInstance.id } });
    if (
      !provider?.enabled ||
      provider.id !== admission.routeProviderId ||
      provider.instanceId !== admission.routeInstanceId
    )
      return null;

    return {
      instance: {
        instanceId: storedInstance.id,
        instanceName: storedInstance.name,
        ownerJid: storedInstance.ownerJid,
        number: storedInstance.number,
      },
      provider,
      client: new ChatwootClient({ config: this.getClientCwConfig(provider) }),
    };
  }

  public getClientCwConfig(
    provider: ChatwootModel,
  ): ChatwootAPIConfig & { nameInbox: string; mergeBrazilContacts: boolean } {
    return {
      basePath: provider.url,
      with_credentials: true,
      credentials: 'include',
      headers: {
        'api-access-token': provider.token,
      },
      nameInbox: provider.nameInbox,
      mergeBrazilContacts: provider.mergeBrazilContacts,
    };
  }

  private trustedChatwootBaseUrl(provider: ChatwootModel): string | null {
    const trustedBaseUrl = this.configService.get<Chatwoot>('CHATWOOT').TRUSTED_BASE_URL;
    return resolveTrustedChatwootBaseUrl(provider.url, trustedBaseUrl);
  }

  private async privilegedChatwootRead(provider: ChatwootModel, path: string): Promise<unknown> {
    const config = this.configService.get<Chatwoot>('CHATWOOT');
    const url = requireTrustedChatwootUrl(provider.url, config.TRUSTED_BASE_URL, path);
    if (!config.NATIVE_BRIDGE_TOKEN) throw new Error('Chatwoot native bridge token is not configured');

    const response = await axios.request({
      method: 'GET',
      url,
      headers: {
        'api-access-token': provider.token,
        'X-Chatwoot-Native-Bridge-Token': config.NATIVE_BRIDGE_TOKEN,
      },
      timeout: 20_000,
      maxRedirects: 0,
    });
    return response.data;
  }

  private async privilegedChatwootRequest(
    provider: ChatwootModel,
    params: { method: 'POST' | 'DELETE'; path: string; data: Record<string, unknown> },
  ): Promise<void> {
    const config = this.configService.get<Chatwoot>('CHATWOOT');
    const url = requireTrustedChatwootUrl(provider.url, config.TRUSTED_BASE_URL, params.path);
    if (!config.NATIVE_BRIDGE_TOKEN) throw new Error('Chatwoot native bridge token is not configured');

    await axios.request({
      method: params.method,
      url,
      data: params.data,
      headers: {
        'api-access-token': provider.token,
        'X-Chatwoot-Native-Bridge-Token': config.NATIVE_BRIDGE_TOKEN,
        'Content-Type': 'application/json',
      },
      timeout: 20_000,
      maxRedirects: 0,
    });
  }

  private async providerConversationRequest(
    provider: ChatwootModel,
    method: 'GET' | 'POST',
    data: Record<string, unknown>,
    rosterInboxId?: number,
  ): Promise<Record<string, any>> {
    const config = this.configService.get<Chatwoot>('CHATWOOT');
    const url = requireTrustedChatwootUrl(
      provider.url,
      config.TRUSTED_BASE_URL,
      `/api/v1/accounts/${provider.accountId}/provider_conversations`,
    );
    if (!config.NATIVE_BRIDGE_TOKEN) throw new Error('Chatwoot native bridge token is not configured');
    const response = await axios.request({
      method,
      url,
      ...(method === 'GET' ? { params: data } : { data }),
      headers: {
        'api-access-token': provider.token,
        'X-Chatwoot-Native-Bridge-Token': config.NATIVE_BRIDGE_TOKEN,
        ...(rosterInboxId
          ? { 'X-Chatwoot-History-Import': '1', 'X-Chatwoot-History-Inbox-Id': String(rosterInboxId) }
          : {}),
      },
      timeout: 20_000,
      maxRedirects: 0,
    });
    return response.data;
  }

  private async providerConversationsEnabled(provider: ChatwootModel, inboxId: number): Promise<boolean> {
    if (!this.configService.get<Chatwoot>('CHATWOOT').PROVIDER_CONVERSATION_BINDINGS) return false;
    const capability = await this.providerConversationRequest(provider, 'GET', { inbox_id: inboxId });
    if (capability.enabled === false) return false;
    if (capability.enabled !== true || capability.provider !== 'whatsapp') {
      throw new Error('Chatwoot provider conversation contract does not match WhatsApp');
    }
    return true;
  }

  private async canonicalProviderConversation(
    instance: InstanceDto,
    provider: ChatwootModel,
    inboxId: number,
    peer: string,
    body: any,
    rosterGroup?: { subject?: string },
  ): Promise<number> {
    const remoteLid = isLidJid(body.key.remoteJid) ? toCanonicalHistoryJid(body.key.remoteJid) : null;
    let contact: any = await this.findProviderContact(instance, peer);
    const isGroup = isGroupJid(peer);
    const user = peer.split('@')[0];
    if (!contact) {
      const group = isGroup
        ? rosterGroup || (await this.waMonitor.waInstances[instance.instanceName].client.groupMetadata(peer))
        : null;
      contact = await this.createContact(
        instance,
        isGroup ? peer : user,
        inboxId,
        isGroup,
        isGroup ? `${group.subject} (GROUP)` : body.pushName || user,
        undefined,
        peer,
        rosterGroup ? inboxId : undefined,
      );
    }
    const contactId = Number(contact?.payload?.id || contact?.payload?.contact?.id || contact?.id);
    if (!Number.isSafeInteger(contactId) || contactId <= 0)
      throw new Error('Provider contact could not be established');
    const resolved = await this.providerConversationRequest(
      provider,
      'POST',
      {
        inbox_id: inboxId,
        contact_id: contactId,
        provider: 'whatsapp',
        peer,
        aliases: remoteLid && remoteLid !== peer ? [remoteLid] : [],
        ...(provider.conversationPending ? { status: 'pending' } : {}),
      },
      rosterGroup ? inboxId : undefined,
    );
    if (
      !Number.isSafeInteger(resolved.id) ||
      resolved.id <= 0 ||
      !Number.isSafeInteger(resolved.database_id) ||
      resolved.database_id <= 0 ||
      resolved.contact_id !== contactId ||
      resolved.inbox_id !== inboxId ||
      resolved.provider !== 'whatsapp' ||
      resolved.peer !== peer
    ) {
      throw new Error('Chatwoot canonical provider conversation result is ambiguous');
    }
    if (!rosterGroup && provider.conversationPending && resolved.status !== 'open' && resolved.status !== 'pending') {
      if (!['resolved', 'snoozed'].includes(resolved.status))
        throw new Error('Provider conversation status is unavailable');
      const context = await this.clientCw(instance);
      await context.client.conversations.toggleStatus({
        accountId: Number(provider.accountId),
        conversationId: resolved.id,
        data: { status: 'pending' },
      });
    }
    if (isGroup && !rosterGroup) {
      await this.ensureProviderGroupParticipant(instance, inboxId, body);
      const rosterKey = `${instance.instanceName}:providerParticipants-${inboxId}-${peer}`;
      if ((await this.cache.get(rosterKey)) !== resolved.id) {
        await this.cache.set(rosterKey, resolved.id, 1800);
        void this.syncWhatsappGroupParticipants(instance, provider, resolved.id, peer);
      }
    }
    return resolved.id;
  }

  private async acquireGroupSyncSlot() {
    if (groupSyncActive < 2) {
      groupSyncActive++;
    } else {
      await new Promise<void>((resolve) => groupSyncWaiters.push(resolve));
    }
  }

  private releaseGroupSyncSlot() {
    const next = groupSyncWaiters.shift();
    if (next) next();
    else groupSyncActive--;
  }

  public async syncParticipatingGroups(instance: InstanceDto, dryRun = true, peers?: string[]) {
    const active = groupSyncs.get(instance.instanceName);
    if (active) {
      await active;
      return this.syncParticipatingGroups(instance, dryRun, peers);
    }
    const task = (async () => {
      await this.acquireGroupSyncSlot();
      try {
        return await this.reconcileParticipatingGroups(instance, dryRun, peers);
      } finally {
        this.releaseGroupSyncSlot();
      }
    })();
    groupSyncs.set(instance.instanceName, task);
    try {
      return await task;
    } finally {
      groupSyncs.delete(instance.instanceName);
    }
  }

  private async findRosterDestinations(provider: ChatwootModel, inboxId: number, peers: string[]) {
    if (!this.pgClient || !this.isImportHistoryAvailable()) return null;
    const destinations = new Map<string, { contact: any; conversation: any }>();
    if (!peers.length) return destinations;
    if (peers.length > 10_000) throw new Error('Native group roster exceeds its lookup bound');
    const accountId = Number(provider.accountId);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('Roster account is unavailable');
    const { rows } = await this.pgClient.query(
      `SELECT ct.id AS contact_id, ct.account_id AS contact_account_id, ct.identifier,
              c.id AS database_id, c.display_id AS conversation_id,
              c.account_id AS conversation_account_id, c.inbox_id, c.status,
              pb.provider AS binding_provider, pb.peer AS binding_peer
       FROM contacts ct
       LEFT JOIN conversations c
         ON c.contact_id = ct.id AND c.account_id = ct.account_id AND c.inbox_id = $2
       LEFT JOIN provider_conversation_bindings pb
         ON pb.conversation_id = c.id
       WHERE ct.account_id = $1 AND ct.identifier = ANY($3::text[])
       ORDER BY ct.identifier, ct.id, c.id`,
      [accountId, inboxId, peers],
    );
    for (const row of rows) {
      if (
        !peers.includes(row.identifier) ||
        destinations.has(row.identifier) ||
        row.contact_account_id !== accountId ||
        !Number.isSafeInteger(row.contact_id) ||
        row.contact_id <= 0 ||
        (row.database_id !== null &&
          (!Number.isSafeInteger(row.database_id) ||
            row.database_id <= 0 ||
            !Number.isSafeInteger(row.conversation_id) ||
            row.conversation_id <= 0 ||
            row.conversation_account_id !== accountId ||
            row.inbox_id !== inboxId)) ||
        (row.binding_provider !== null && (row.binding_provider !== 'whatsapp' || row.binding_peer !== row.identifier))
      )
        throw new Error('Group roster destination identity conflicts');
      destinations.set(row.identifier, {
        contact: { id: row.contact_id },
        conversation:
          row.database_id === null
            ? null
            : {
                id: row.conversation_id,
                database_id: row.database_id,
                contact_id: row.contact_id,
                inbox_id: row.inbox_id,
                provider: 'whatsapp',
                peer: row.identifier,
              },
      });
    }
    return destinations;
  }

  private async reconcileParticipatingGroups(instance: InstanceDto, dryRun: boolean, peers?: string[]) {
    const waInstance = this.waMonitor.waInstances[instance.instanceName];
    const context = await this.clientCw(instance);
    const inbox = await this.getInbox(instance);
    if (!context?.provider?.enabled || !inbox || !waInstance?.client?.authState?.creds?.me?.id)
      throw new BadRequestException('An authenticated provider and its bound inbox are required');
    if (waInstance.localSettings?.groupsIgnore)
      throw new BadRequestException('Group ingestion is disabled for this instance');
    const capability = await this.providerConversationRequest(context.provider, 'GET', { inbox_id: inbox.id });
    if (
      capability.enabled !== true ||
      capability.provider !== 'whatsapp' ||
      capability.whatsapp_group_roster_contract_version !== 1
    )
      throw new BadRequestException('The silent canonical WhatsApp group roster contract is required');
    // This authenticated IQ returns the current session's joined groups. A community
    // or LID roster need not repeat the receiver as a PN participant in its metadata.
    const groups = Object.values(await waInstance.client.groupFetchAllParticipating(false)) as any[];
    const rosterPeers = groups
      .filter((group) => isGroupJid(group.id) && (!peers || peers.includes(group.id)))
      .map((group) => group.id);
    const destinations = await this.findRosterDestinations(context.provider, inbox.id, rosterPeers);
    const results = [];
    for (const group of groups) {
      if (!isGroupJid(group.id) || (peers && !peers.includes(group.id))) continue;
      const destination = destinations?.get(group.id);
      const contact = destinations ? destination?.contact : await this.findProviderContact(instance, group.id);
      const existing = destinations
        ? { conversation: destination?.conversation }
        : contact
          ? await this.providerConversationRequest(context.provider, 'GET', {
              inbox_id: inbox.id,
              contact_id: contact.id,
              provider: 'whatsapp',
              peer: group.id,
            })
          : null;
      const conversation = existing?.conversation;
      if (
        conversation &&
        (conversation.inbox_id !== inbox.id ||
          conversation.peer !== group.id ||
          conversation.contact_id !== contact.id ||
          conversation.provider !== 'whatsapp')
      )
        throw new Error('Group conversation identity conflicts');
      const id =
        conversation?.id ||
        (dryRun
          ? null
          : await this.canonicalProviderConversation(
              instance,
              context.provider,
              inbox.id,
              group.id,
              { key: { remoteJid: group.id } },
              group,
            ));
      results.push({ peer: group.id, subject: group.subject, conversationId: id, missing: !conversation });
    }
    return { instance: instance.instanceName, inboxId: inbox.id, dryRun, groups: results };
  }

  private scheduleParticipatingGroups(instance: InstanceDto, peers?: string[]) {
    const name = instance.instanceName;
    const pending = pendingGroupSyncs.get(name);
    pendingGroupSyncs.set(
      name,
      pendingGroupSyncs.has(name) ? (pending && peers ? [...new Set([...pending, ...peers])] : undefined) : peers,
    );
    if (scheduledGroupSyncs.has(name)) return;
    scheduledGroupSyncs.add(name);
    // Bounded background reconciliation never holds the live ingestion handler.
    void (async () => {
      try {
        while (pendingGroupSyncs.has(name)) {
          const selected = pendingGroupSyncs.get(name);
          pendingGroupSyncs.delete(name);
          try {
            await this.syncParticipatingGroups(instance, false, selected);
          } catch (error) {
            this.logger.error(`Group roster reconciliation failed for ${name}: ${error.message}`);
          }
        }
      } finally {
        scheduledGroupSyncs.delete(name);
      }
    })();
  }

  private async ensureProviderGroupParticipant(instance: InstanceDto, inboxId: number, body: any): Promise<void> {
    if (body.key.fromMe || !body.key.participant) return;
    const nativeParticipant =
      isLidJid(body.key.participant) && isPhoneJid(body.key.participantAlt)
        ? body.key.participantAlt
        : body.key.participant;
    const participant = toCanonicalHistoryJid(nativeParticipant);
    if (!isPhoneJid(participant) && !isLidJid(participant))
      throw new Error('Group participant native identity is unsupported');
    const contact = await this.findProviderContact(instance, participant);
    const user = participant.split('@')[0];
    if (contact) {
      if ((isPhoneJid(contact.identifier) || isLidJid(contact.identifier)) && contact.identifier !== participant)
        throw new Error('Group participant contact identity conflicts');
      if (body.pushName && (!contact.name || contact.name === user))
        await this.updateContact(instance, contact.id, { name: body.pushName });
      return;
    }
    const result: any = await this.createContact(
      instance,
      user,
      inboxId,
      false,
      body.pushName || user,
      undefined,
      participant,
    );
    const created = result?.payload?.contact || result?.payload || result;
    const createdId = created?.id;
    if (
      typeof createdId !== 'number' ||
      !Number.isSafeInteger(createdId) ||
      createdId <= 0 ||
      created?.identifier !== participant
    )
      throw new Error('Group participant contact creation could not be verified');
  }

  private async findProviderContact(instance: InstanceDto, peer: string) {
    const context = await this.clientCw(instance);
    if (!context) throw new Error('Provider contact lookup context is unavailable');
    const lookup = async (attribute: 'identifier' | 'phone_number', value: string) => {
      const response: any = await context.client.contacts.filter({
        accountId: Number(context.provider.accountId),
        payload: [{ attribute_key: attribute, filter_operator: 'equal_to', values: [value] }],
      });
      if (!Array.isArray(response) && !Array.isArray(response?.payload) && !Array.isArray(response?.data?.payload))
        throw new Error('Provider contact lookup result is unavailable');
      const contacts = extractChatwootContacts(response);
      const count = response?.meta?.count ?? response?.data?.meta?.count;
      if (
        contacts.length > 1 ||
        (count !== undefined && (!Number.isSafeInteger(count) || count !== contacts.length)) ||
        contacts.some(
          (item) =>
            item[attribute] !== value || typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id <= 0,
        )
      )
        throw new Error('Provider contact lookup identity is ambiguous');
      return contacts[0] || null;
    };
    const exact = await lookup('identifier', peer);
    if (exact || !isPhoneJid(peer)) return exact;
    const phone = await lookup('phone_number', `+${peer.split('@')[0]}`);
    if (
      phone &&
      (isPhoneJid(phone.identifier) || isLidJid(phone.identifier) || isGroupJid(phone.identifier)) &&
      phone.identifier !== peer
    )
      throw new Error('Provider phone contact identity conflicts');
    return phone;
  }

  public async applyWhatsappProviderEdit(
    provider: ChatwootModel,
    target: {
      messageId: number;
      conversationId: number;
      sourceId: string;
      direction: string;
      content: string;
      providerRecoveryGuard?: { content: string | null; content_attributes: unknown };
    },
  ): Promise<void> {
    await this.privilegedChatwootRequest(provider, {
      method: 'POST',
      path: `/api/v1/accounts/${provider.accountId}/conversations/${target.conversationId}/messages/${target.messageId}/edit`,
      data: {
        content: target.content,
        source_id: target.sourceId,
        message_type: target.direction,
        skip_native: true,
        provider_source: 'whatsapp',
        ...(target.providerRecoveryGuard ? { provider_recovery_guard: target.providerRecoveryGuard } : {}),
      },
    });
  }

  public getCache() {
    return this.cache;
  }

  public async externalRead(
    instance: InstanceDto,
    params: { conversationId: number; messageId: number; sourceCursor: string },
  ): Promise<{ owners_updated?: number; owners_unchanged?: number } | null> {
    const token = this.configService.get<Chatwoot>('CHATWOOT').READ_STATE_INGRESS_TOKEN;
    if (!token) return null;

    const provider = await this.getProvider(instance);
    if (!provider) {
      this.logger.warn('provider not found for external read');
      return null;
    }

    const trustedBaseUrl = this.trustedChatwootBaseUrl(provider);
    if (!trustedBaseUrl) {
      this.logger.warn('provider URL is not the operator-controlled Chatwoot destination');
      return null;
    }

    const request = buildExternalReadRequest({
      baseUrl: trustedBaseUrl,
      accountId: provider.accountId,
      conversationId: params.conversationId,
      messageId: params.messageId,
      sourceCursor: params.sourceCursor,
      token,
    });
    const response = await axios.post(request.url, request.data, {
      headers: request.headers,
      timeout: 20_000,
      maxRedirects: 0,
    });

    return response.data;
  }

  public async create(instance: InstanceDto, data: ChatwootDto) {
    // The HTTP route contains only instanceName. Resolve the durable ID before
    // persisting the inbox signing secret; never trust a query-supplied ID.
    const storedInstance = await this.prismaRepository.instance.findUniqueOrThrow({
      where: { name: instance.instanceName },
      select: { id: true },
    });
    instance = { ...instance, instanceId: storedInstance.id };
    await this.waMonitor.waInstances[instance.instanceName].setChatwoot(data);

    if (data.autoCreate) {
      this.logger.log('Auto create chatwoot instance');
      const urlServer = this.configService.get<HttpServer>('SERVER').URL;

      await this.initInstanceChatwoot(
        instance,
        data.nameInbox ?? instance.instanceName.split('-cwId-')[0],
        `${urlServer}/chatwoot/webhook/${encodeURIComponent(instance.instanceName)}`,
        true,
        data.number,
        data.organization,
        data.logo,
      );
    } else {
      const inbox = await this.getInbox(instance, true);
      const webhookSecret = (inbox as any)?.secret;
      if (typeof webhookSecret === 'string' && webhookSecret.length >= CHATWOOT_WEBHOOK_SECRET_MIN_LENGTH) {
        await this.prismaRepository.chatwoot.update({
          where: { instanceId: instance.instanceId },
          data: { webhookSecret },
        });
        await this.cache.deleteAll(instance.instanceName);
      }
    }
    return data;
  }

  public async find(instance: InstanceDto): Promise<ChatwootDto> {
    try {
      return await this.waMonitor.waInstances[instance.instanceName].findChatwoot();
    } catch {
      this.logger.error('chatwoot not found');
      return { enabled: null, url: '' };
    }
  }

  public async getContact(instance: InstanceDto, id: number) {
    const context = await this.clientCw(instance);

    if (!context) {
      this.logger.warn('client not found');
      return null;
    }
    const { client, provider } = context;

    if (!id) {
      this.logger.warn('id is required');
      return null;
    }

    const contact = await client.contact.getContactable({
      accountId: Number(provider.accountId),
      id,
    });

    if (!contact) {
      this.logger.warn('contact not found');
      return null;
    }

    return contact;
  }

  public async initInstanceChatwoot(
    instance: InstanceDto,
    inboxName: string,
    webhookUrl: string,
    qrcode: boolean,
    number: string,
    organization?: string,
    logo?: string,
  ) {
    const context = await this.clientCw(instance);

    if (!context) {
      this.logger.warn('client not found');
      return null;
    }
    const { client, provider } = context;

    const findInbox: any = await client.inboxes.list({
      accountId: Number(provider.accountId),
    });

    const checkDuplicate = findInbox.payload.map((inbox) => inbox.name).includes(inboxName);

    let inboxId: number;
    let selectedInbox: inbox;

    this.logger.log('Creating chatwoot inbox');
    if (!checkDuplicate) {
      const data = {
        type: 'api',
        webhook_url: webhookUrl,
        additional_attributes: {
          we_digital_provider: 'evo_whatsapp',
          we_digital_provider_contract_version: 2,
        },
      };

      const inbox = await client.inboxes.create({
        accountId: Number(provider.accountId),
        data: {
          name: inboxName,
          channel: data as any,
        },
      });

      if (!inbox) {
        this.logger.warn('inbox not found');
        return null;
      }

      inboxId = inbox.id;
      selectedInbox = inbox;
    } else {
      const inbox = findInbox.payload.find((inbox) => inbox.name === inboxName);

      if (!inbox) {
        this.logger.warn('inbox not found');
        return null;
      }

      inboxId = inbox.id;
      selectedInbox = inbox;
    }
    await this.reconcileChatwootRouteBinding(instance, provider, selectedInbox, true);
    const webhookSecret = (selectedInbox as any)?.secret;
    if (typeof webhookSecret === 'string' && webhookSecret.length >= CHATWOOT_WEBHOOK_SECRET_MIN_LENGTH) {
      await this.prismaRepository.chatwoot.update({
        where: { instanceId: instance.instanceId },
        data: { webhookSecret },
      });
      await this.cache.deleteAll(instance.instanceName);
    }
    this.logger.log(`Inbox created - inboxId: ${inboxId}`);

    if (!this.configService.get<Chatwoot>('CHATWOOT').BOT_CONTACT) {
      this.logger.log('Chatwoot bot contact is disabled');

      return true;
    }

    this.logger.log('Creating chatwoot bot contact');
    const contact =
      (await this.findContact(instance, '123456')) ||
      ((await this.createContact(
        instance,
        '123456',
        inboxId,
        false,
        organization ? organization : 'EvolutionAPI',
        logo ? logo : 'https://evolution-api.com/files/evolution-api-favicon.png',
      )) as any);

    if (!contact) {
      this.logger.warn('contact not found');
      return null;
    }

    const contactId = contact.id || contact.payload.contact.id;
    this.logger.log(`Contact created - contactId: ${contactId}`);

    if (qrcode) {
      this.logger.log('QR code enabled');
      const data = {
        contact_id: contactId.toString(),
        inbox_id: inboxId.toString(),
      };

      const conversation = await client.conversations.create({
        accountId: Number(provider.accountId),
        data,
      });

      if (!conversation) {
        this.logger.warn('conversation not found');
        return null;
      }

      let contentMsg = 'init';

      if (number) {
        contentMsg = `init:${number}`;
      }

      const message = await client.messages.create({
        accountId: Number(provider.accountId),
        conversationId: conversation.id,
        data: {
          content: contentMsg,
          message_type: 'outgoing',
        },
      });

      if (!message) {
        this.logger.warn('conversation not found');
        return null;
      }
      this.logger.log('Init message sent');
    }

    return true;
  }

  public async createContact(
    instance: InstanceDto,
    phoneNumber: string,
    inboxId: number,
    isGroup: boolean,
    name?: string,
    avatar_url?: string,
    jid?: string,
    rosterInboxId?: number,
  ) {
    try {
      const context = await this.clientCw(instance);

      if (!context) {
        this.logger.warn('client not found');
        return null;
      }
      const { provider } = context;
      const config = this.configService.get<Chatwoot>('CHATWOOT');
      const client = rosterInboxId
        ? new ChatwootClient({
            config: {
              ...this.getClientCwConfig(provider),
              headers: {
                ...this.getClientCwConfig(provider).headers,
                'X-Chatwoot-Native-Bridge-Token': config.NATIVE_BRIDGE_TOKEN,
                'X-Chatwoot-History-Import': '1',
                'X-Chatwoot-History-Inbox-Id': String(rosterInboxId),
              },
            },
          })
        : context.client;

      let data: any = {};
      if (!isGroup) {
        const isLidIdentifier = typeof jid === 'string' && (jid.endsWith('@lid') || jid.endsWith('@hosted.lid'));
        data = {
          inbox_id: inboxId,
          name: name || phoneNumber,
          identifier: jid,
          avatar_url: avatar_url,
        };

        // Provisional LID contacts must not invent a phone_number from the LID user id.
        if (!isLidIdentifier && (!jid || jid.includes('@'))) {
          data['phone_number'] = `+${phoneNumber}`;
        }
      } else {
        data = {
          inbox_id: inboxId,
          name: name || phoneNumber,
          identifier: phoneNumber,
          avatar_url: avatar_url,
        };
      }

      const contact = await client.contacts.create({
        accountId: Number(provider.accountId),
        data,
      });

      if (!contact) {
        this.logger.warn('contact not found');
        return null;
      }

      const createdContact = contact as any;
      const createdContactId =
        createdContact?.payload?.id || createdContact?.payload?.contact?.id || createdContact?.id;
      const persistedContact = createdContactId
        ? null
        : jid
          ? await this.findContactByIdentifier(instance, jid)
          : await this.findContact(instance, phoneNumber);
      const contactId = createdContactId || persistedContact?.id;

      if (contactId && !rosterInboxId) {
        await this.addLabelToContact(provider.nameInbox, contactId);
      }

      return contact;
    } catch (error) {
      if ((error.status === 422 || error.response?.status === 422) && jid) {
        this.logger.warn(`Contact with identifier ${jid} creation failed (422). Checking if it already exists...`);
        const existingContact = await this.findContactByIdentifier(instance, jid);
        if (existingContact) {
          const contactId = existingContact.id;
          const provider = await this.getProvider(instance);
          if (!provider) {
            return null;
          }
          if (!rosterInboxId) await this.addLabelToContact(provider.nameInbox, contactId);
          return existingContact;
        }
      }

      this.logger.error('Error creating contact');
      return null;
    }
  }

  public async updateContact(instance: InstanceDto, id: number, data: any) {
    const context = await this.clientCw(instance);

    if (!context) {
      this.logger.warn('client not found');
      return null;
    }
    const { client, provider } = context;

    if (!id) {
      this.logger.warn('id is required');
      return null;
    }

    try {
      const contact = await client.contacts.update({
        accountId: Number(provider.accountId),
        id,
        data,
      });

      return contact;
    } catch {
      return null;
    }
  }

  public async addLabelToContact(nameInbox: string, contactId: number) {
    try {
      const uri = this.configService.get<Chatwoot>('CHATWOOT').IMPORT.DATABASE.CONNECTION.URI;

      if (!uri) return false;

      const sqlTags = `SELECT id, taggings_count FROM tags WHERE name = $1 LIMIT 1`;
      const tagData = (await this.pgClient.query(sqlTags, [nameInbox]))?.rows[0];
      let tagId = tagData?.id;
      const taggingsCount = tagData?.taggings_count || 0;

      const sqlTag = `INSERT INTO tags (name, taggings_count) 
                      VALUES ($1, $2) 
                      ON CONFLICT (name) 
                      DO UPDATE SET taggings_count = tags.taggings_count + 1 
                      RETURNING id`;

      tagId = (await this.pgClient.query(sqlTag, [nameInbox, taggingsCount + 1]))?.rows[0]?.id;

      const sqlCheckTagging = `SELECT 1 FROM taggings 
                               WHERE tag_id = $1 AND taggable_type = 'Contact' AND taggable_id = $2 AND context = 'labels' LIMIT 1`;

      const taggingExists = (await this.pgClient.query(sqlCheckTagging, [tagId, contactId]))?.rowCount > 0;

      if (!taggingExists) {
        const sqlInsertLabel = `INSERT INTO taggings (tag_id, taggable_type, taggable_id, context, created_at) 
                                VALUES ($1, 'Contact', $2, 'labels', NOW())`;

        await this.pgClient.query(sqlInsertLabel, [tagId, contactId]);
      }

      return true;
    } catch {
      return false;
    }
  }

  public async findContactByIdentifier(instance: InstanceDto, identifier: string) {
    const context = await this.clientCw(instance);

    if (!context) {
      this.logger.warn('client not found');
      return null;
    }
    const { client, provider } = context;

    const searchResult = await client.contacts.search({
      accountId: Number(provider.accountId),
      q: identifier,
      sort: 'name',
    });
    const searchContacts = extractChatwootContacts(searchResult);
    const exactSearchMatch = searchContacts.find((contact) => contact.identifier === identifier);
    if (exactSearchMatch) {
      return exactSearchMatch;
    }

    const filterResult = await client.contacts.filter({
      accountId: Number(provider.accountId),
      payload: [
        {
          attribute_key: 'identifier',
          filter_operator: 'equal_to',
          values: [identifier],
        },
      ],
    });
    const filteredContacts = extractChatwootContacts(filterResult);

    return filteredContacts.find((contact) => contact.identifier === identifier) || filteredContacts[0] || null;
  }

  public async findContact(instance: InstanceDto, phoneNumber: string) {
    const context = await this.clientCw(instance);

    if (!context) {
      this.logger.warn('client not found');
      return null;
    }
    const { client, provider } = context;

    let query: any;
    const isGroup = phoneNumber.includes('@g.us');

    if (!isGroup) {
      query = `+${phoneNumber}`;
    } else {
      query = phoneNumber;
    }

    let contact: any;

    if (isGroup) {
      contact = await client.contacts.search({
        accountId: Number(provider.accountId),
        q: query,
      });
    } else {
      contact = await chatwootRequest(this.getClientCwConfig(provider), {
        method: 'POST',
        url: `/api/v1/accounts/${provider.accountId}/contacts/filter`,
        body: {
          payload: this.getFilterPayload(query),
        },
      });
    }

    const contacts = extractChatwootContacts(contact);
    if (contacts.length === 0) {
      this.logger.warn('contact not found');
      return null;
    }

    if (!isGroup) {
      return contacts.length > 1 ? this.findContactInContactList(contacts, query, provider) : contacts[0];
    } else {
      return contacts.find((contact) => contact.identifier === query);
    }
  }

  public async mergeContacts(baseId: number, mergeId: number, provider: ChatwootModel) {
    try {
      const contact = await chatwootRequest(this.getClientCwConfig(provider), {
        method: 'POST',
        url: `/api/v1/accounts/${provider.accountId}/actions/contact_merge`,
        body: {
          base_contact_id: baseId,
          mergee_contact_id: mergeId,
        },
      });

      return contact;
    } catch {
      this.logger.error('Error merging contacts');
      return null;
    }
  }

  private async mergeBrazilianContacts(contacts: any[], provider: ChatwootModel) {
    try {
      const contact = await chatwootRequest(this.getClientCwConfig(provider), {
        method: 'POST',
        url: `/api/v1/accounts/${provider.accountId}/actions/contact_merge`,
        body: {
          base_contact_id: contacts.find((contact) => contact.phone_number.length === 14)?.id,
          mergee_contact_id: contacts.find((contact) => contact.phone_number.length === 13)?.id,
        },
      });

      return contact;
    } catch {
      this.logger.error('Error merging contacts');
      return null;
    }
  }

  private findContactInContactList(contacts: any[], query: string, provider: ChatwootModel) {
    const phoneNumbers = this.getNumbers(query);
    const searchableFields = this.getSearchableFields();

    // eslint-disable-next-line prettier/prettier
    if (contacts.length === 2 && this.getClientCwConfig(provider).mergeBrazilContacts && query.startsWith('+55')) {
      const contact = this.mergeBrazilianContacts(contacts, provider);
      if (contact) {
        return contact;
      }
    }

    const phone = phoneNumbers.reduce(
      (savedNumber, number) => (number.length > savedNumber.length ? number : savedNumber),
      '',
    );

    const contact_with9 = contacts.find((contact) => contact.phone_number === phone);
    if (contact_with9) {
      return contact_with9;
    }

    for (const contact of contacts) {
      for (const field of searchableFields) {
        if (contact[field] && phoneNumbers.includes(contact[field])) {
          return contact;
        }
      }
    }

    return null;
  }

  private getNumbers(query: string) {
    const numbers = [];
    numbers.push(query);

    if (query.startsWith('+55') && query.length === 14) {
      const withoutNine = query.slice(0, 5) + query.slice(6);
      numbers.push(withoutNine);
    } else if (query.startsWith('+55') && query.length === 13) {
      const withNine = query.slice(0, 5) + '9' + query.slice(5);
      numbers.push(withNine);
    }

    return numbers;
  }

  private getSearchableFields() {
    return ['phone_number'];
  }

  private getFilterPayload(query: string) {
    const filterPayload = [];

    const numbers = this.getNumbers(query);
    const fieldsToSearch = this.getSearchableFields();

    fieldsToSearch.forEach((field, index1) => {
      numbers.forEach((number, index2) => {
        const queryOperator = fieldsToSearch.length - 1 === index1 && numbers.length - 1 === index2 ? null : 'OR';
        filterPayload.push({
          attribute_key: field,
          filter_operator: 'equal_to',
          values: [number.replace('+', '')],
          query_operator: queryOperator,
        });
      });
    });

    return filterPayload;
  }

  public async createConversation(instance: InstanceDto, body: any) {
    const remoteJid = typeof body?.key?.remoteJid === 'string' ? body.key.remoteJid : '';
    if (!remoteJid) {
      this.logger.warn('createConversation: missing remoteJid');
      return null;
    }

    const isGroup = remoteJid.endsWith('@g.us');
    const isDirectLid = !isGroup && (body.key.addressingMode === 'lid' || isLidJid(remoteJid));
    let phoneNumber: string | undefined = isDirectLid
      ? typeof body.key.remoteJidAlt === 'string'
        ? body.key.remoteJidAlt
        : undefined
      : remoteJid;

    // Baileys sometimes omits remoteJidAlt for LID chats. Resolve PN when possible;
    // otherwise keep a provisional @lid identity so ingress does not drop the message.
    if (isDirectLid && !isPhoneJid(phoneNumber)) {
      const lidJid = isLidJid(remoteJid) ? remoteJid : phoneNumber;
      const waInstance = this.waMonitor.waInstances[instance.instanceName];
      const resolved =
        lidJid && waInstance?.resolvePhoneJidForLid ? await waInstance.resolvePhoneJidForLid(lidJid) : null;
      if (isPhoneJid(resolved)) {
        phoneNumber = resolved;
        body.key.remoteJidAlt = resolved;
        this.logger.verbose(`Resolved LID ${lidJid} → ${resolved} for createConversation`);
      } else if (isLidJid(lidJid)) {
        phoneNumber = toCanonicalHistoryJid(lidJid);
        this.logger.warn(`Using provisional LID contact for createConversation: ${phoneNumber}`);
      } else {
        this.logger.warn(`Unable to resolve LID for createConversation: ${remoteJid}`);
        return null;
      }
    }

    const isProvisionalLid = isDirectLid && isLidJid(phoneNumber);
    const cacheKey = `${instance.instanceName}:createConversation-${remoteJid}`;
    const lockKey = `${instance.instanceName}:lock:createConversation-${remoteJid}`;
    const maxWaitTime = 5000; // 5 seconds
    const context = await this.clientCw(instance);
    if (!context) return null;
    const { client, provider } = context;

    try {
      const providerInbox = await this.getInbox(instance);
      if (!providerInbox) return null;
      if (await this.providerConversationsEnabled(provider, Number(providerInbox.id))) {
        // A legacy cache entry must not bypass the shared database binding.
        return await this.canonicalProviderConversation(
          instance,
          provider,
          Number(providerInbox.id),
          toCanonicalHistoryJid(phoneNumber),
          body,
        );
      }

      // Processa atualização de contatos já criados @lid (only when we have a real PN)
      if (phoneNumber && remoteJid && !isGroup && !isProvisionalLid) {
        const contact = await this.findContact(instance, phoneNumber.split('@')[0]);
        if (contact && contact.identifier !== remoteJid) {
          this.logger.verbose(
            `Identifier needs update: (contact.identifier: ${contact.identifier}, phoneNumber: ${phoneNumber}, body.key.remoteJidAlt: ${remoteJid}`,
          );
          const updateContact = await this.updateContact(instance, contact.id, {
            identifier: phoneNumber,
            phone_number: `+${phoneNumber.split('@')[0]}`,
          });

          if (updateContact === null) {
            const baseContact = await this.findContact(instance, phoneNumber.split('@')[0]);
            if (baseContact) {
              await this.mergeContacts(baseContact.id, contact.id, provider);
              this.logger.verbose(
                `Merge contacts: (${baseContact.id}) ${baseContact.phone_number} and (${contact.id}) ${contact.phone_number}`,
              );
            }
          }
        }
      }
      this.logger.verbose(`--- Start createConversation ---`);
      this.logger.verbose(`Instance: ${JSON.stringify(instance)}`);

      // If it already exists in the cache, return conversationId
      if (await this.cache.has(cacheKey)) {
        const conversationId = (await this.cache.get(cacheKey)) as number;
        this.logger.verbose(`Found conversation to: ${phoneNumber}, conversation ID: ${conversationId}`);
        let conversationExists: any;
        try {
          conversationExists = await client.conversations.get({
            accountId: Number(provider.accountId),
            conversationId: conversationId,
          });
          this.logger.verbose(
            `Conversation exists: ID: ${conversationExists.id} - Name: ${conversationExists.meta.sender.name} - Identifier: ${conversationExists.meta.sender.identifier}`,
          );
        } catch (error) {
          this.logger.error(`Error getting conversation: ${error}`);
          conversationExists = false;
        }
        if (!conversationExists) {
          this.logger.verbose('Conversation does not exist, re-calling createConversation');
          this.cache.delete(cacheKey);
          return await this.createConversation(instance, body);
        }
        return conversationId;
      }

      // If lock already exists, wait until release or timeout
      if (await this.cache.has(lockKey)) {
        this.logger.verbose(`Operação de criação já em andamento para ${remoteJid}, aguardando resultado...`);
        const start = Date.now();
        while (await this.cache.has(lockKey)) {
          if (Date.now() - start > maxWaitTime) {
            this.logger.warn(`Timeout aguardando lock para ${remoteJid}`);
            break;
          }
          await new Promise((res) => setTimeout(res, this.LOCK_POLLING_DELAY_MS));
          if (await this.cache.has(cacheKey)) {
            const conversationId = (await this.cache.get(cacheKey)) as number;
            this.logger.verbose(`Resolves creation of: ${remoteJid}, conversation ID: ${conversationId}`);
            return conversationId;
          }
        }
      }

      // Adquire lock
      await this.cache.set(lockKey, true, 30);
      this.logger.verbose(`Bloqueio adquirido para: ${lockKey}`);

      try {
        /*
        Double check after lock
        Utilizei uma nova verificação para evitar que outra thread execute entre o terminio do while e o set lock
        */
        if (await this.cache.has(cacheKey)) {
          return (await this.cache.get(cacheKey)) as number;
        }

        const chatId = isGroup ? remoteJid : isProvisionalLid ? phoneNumber : phoneNumber.split('@')[0].split(':')[0];
        let nameContact = !body.key.fromMe ? body.pushName : chatId;
        const filterInbox = await this.getInbox(instance);
        if (!filterInbox) return null;

        if (isGroup) {
          this.logger.verbose(`Processing group conversation`);
          const group = await this.waMonitor.waInstances[instance.instanceName].client.groupMetadata(chatId);
          this.logger.verbose(`Group metadata: JID:${group.JID} - Subject:${group?.subject || group?.Name}`);

          const participantJid =
            !body.key.fromMe && isLidJid(body.key.participant) && isPhoneJid(body.key.participantAlt)
              ? body.key.participantAlt
              : body.key.participant;
          const isProvisionalParticipantLid = isLidJid(participantJid);
          nameContact = `${group.subject} (GROUP)`;

          const picture_url = await this.waMonitor.waInstances[instance.instanceName].profilePicture(participantJid);
          this.logger.verbose(`Participant profile picture URL: ${JSON.stringify(picture_url)}`);

          const findParticipant = isProvisionalParticipantLid
            ? await this.findContactByIdentifier(instance, participantJid)
            : await this.findContact(instance, participantJid.split('@')[0]);

          if (findParticipant) {
            this.logger.verbose(
              `Found participant: ID:${findParticipant.id} - Name: ${findParticipant.name} - identifier: ${findParticipant.identifier}`,
            );
            if (!findParticipant.name || findParticipant.name === chatId) {
              await this.updateContact(instance, findParticipant.id, {
                name: body.pushName,
                avatar_url: picture_url.profilePictureUrl || null,
              });
            }
          } else {
            await this.createContact(
              instance,
              participantJid.split('@')[0].split(':')[0],
              filterInbox.id,
              false,
              body.pushName,
              picture_url.profilePictureUrl || null,
              participantJid,
            );
          }
        }

        const pictureLookupId = isProvisionalLid ? phoneNumber : chatId;
        const picture_url = await this.waMonitor.waInstances[instance.instanceName].profilePicture(pictureLookupId);
        this.logger.verbose(`Contact profile picture URL: ${JSON.stringify(picture_url)}`);

        this.logger.verbose(`Searching contact for: ${chatId}`);
        let contact = isProvisionalLid
          ? await this.findContactByIdentifier(instance, phoneNumber)
          : await this.findContact(instance, chatId);

        if (contact) {
          this.logger.verbose(`Found contact: ID:${contact.id} - Name:${contact.name}`);
          if (!body.key.fromMe) {
            const waProfilePictureFile =
              picture_url?.profilePictureUrl?.split('#')[0].split('?')[0].split('/').pop() || '';
            const chatwootProfilePictureFile = contact?.thumbnail?.split('#')[0].split('?')[0].split('/').pop() || '';
            const pictureNeedsUpdate = waProfilePictureFile !== chatwootProfilePictureFile;
            const nameNeedsUpdate = !contact.name || contact.name === chatId;
            this.logger.verbose(`Picture needs update: ${pictureNeedsUpdate}`);
            this.logger.verbose(`Name needs update: ${nameNeedsUpdate}`);
            if (pictureNeedsUpdate || nameNeedsUpdate) {
              contact = await this.updateContact(instance, contact.id, {
                ...(nameNeedsUpdate && { name: nameContact }),
                ...(waProfilePictureFile === '' && { avatar: null }),
                ...(pictureNeedsUpdate && { avatar_url: picture_url?.profilePictureUrl }),
              });
            }
          }
        } else {
          contact = await this.createContact(
            instance,
            isProvisionalLid ? phoneNumber.split('@')[0] : chatId,
            filterInbox.id,
            isGroup,
            nameContact,
            picture_url.profilePictureUrl || null,
            phoneNumber,
          );
        }

        if (!contact) {
          this.logger.warn(`Contact not created or found`);
          return null;
        }

        const contactId = contact?.payload?.id || contact?.payload?.contact?.id || contact?.id;
        this.logger.verbose(`Contact ID: ${contactId}`);

        const contactConversations = (await client.contacts.listConversations({
          accountId: Number(provider.accountId),
          id: contactId,
        })) as any;

        if (!contactConversations || !contactConversations.payload) {
          this.logger.error(`No conversations found or payload is undefined`);
          return null;
        }

        let inboxConversation = contactConversations.payload.find(
          (conversation) => conversation.inbox_id == filterInbox.id,
        );
        if (inboxConversation) {
          if (provider.reopenConversation) {
            this.logger.verbose(
              `Found conversation in reopenConversation mode: ID: ${inboxConversation.id} - Name: ${inboxConversation.meta.sender.name} - Identifier: ${inboxConversation.meta.sender.identifier}`,
            );
            if (inboxConversation && provider.conversationPending && inboxConversation.status !== 'open') {
              await client.conversations.toggleStatus({
                accountId: Number(provider.accountId),
                conversationId: inboxConversation.id,
                data: {
                  status: 'pending',
                },
              });
            }
          } else {
            inboxConversation = contactConversations.payload.find(
              (conversation) =>
                conversation && conversation.status !== 'resolved' && conversation.inbox_id == filterInbox.id,
            );
            this.logger.verbose(`Found conversation: ${JSON.stringify(inboxConversation)}`);
          }

          if (inboxConversation) {
            this.logger.verbose(`Returning existing conversation ID: ${inboxConversation.id}`);
            this.cache.set(cacheKey, inboxConversation.id, 1800);
            if (isGroup) {
              void this.syncWhatsappGroupParticipants(instance, provider, Number(inboxConversation.id), chatId);
            }
            return inboxConversation.id;
          }
        }

        const data = {
          contact_id: contactId.toString(),
          inbox_id: filterInbox.id.toString(),
        };

        if (provider.conversationPending) {
          data['status'] = 'pending';
        }

        const conversation = await client.conversations.create({
          accountId: Number(provider.accountId),
          data,
        });

        if (!conversation) {
          this.logger.warn(`Conversation not created or found`);
          return null;
        }

        this.logger.verbose(`New conversation created of ${remoteJid} with ID: ${conversation.id}`);
        this.cache.set(cacheKey, conversation.id, 1800);
        if (isGroupJid(remoteJid)) {
          void this.syncWhatsappGroupParticipants(instance, provider, Number(conversation.id), remoteJid);
        }
        return conversation.id;
      } finally {
        await this.cache.delete(lockKey);
        this.logger.verbose(`Block released for: ${lockKey}`);
      }
    } catch (error) {
      this.logger.error(`Error in createConversation: ${error}`);
      return null;
    }
  }

  private async syncWhatsappGroupParticipants(
    instance: InstanceDto,
    provider: ChatwootModel,
    conversationId: number,
    groupJid: string,
  ): Promise<ReturnType<typeof buildWhatsappGroupParticipantSnapshots>> {
    try {
      const waInstance = this.waMonitor.waInstances[instance.instanceName];
      if (!waInstance?.findParticipants) return [];
      const groupParticipants = await waInstance.findParticipants({ groupJid });
      const snapshots = buildWhatsappGroupParticipantSnapshots(groupParticipants?.participants || []);
      if (!snapshots.length) return [];

      await chatwootRequest(this.getClientCwConfig(provider), {
        method: 'POST',
        url: `/api/v1/accounts/${provider.accountId}/conversations/${conversationId}/custom_attributes`,
        body: {
          merge: true,
          custom_attributes: {
            whatsapp_group_participants: snapshots,
          },
        },
      });
      return snapshots;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'chatwoot_group_participants_sync_failed',
          conversationId,
          groupJid,
          errorClass: (error as any)?.name || 'Error',
          message: (error as any)?.message,
        }),
      );
      return [];
    }
  }

  private buildEvoRouteBinding(
    instance: InstanceDto,
    provider: ChatwootModel,
    inboxId: number,
  ): ChatwootEvoRouteBinding | null {
    const localWaInstance = this.waMonitor.waInstances[instance.instanceName] as any;
    const waInstance =
      !instance.instanceId || localWaInstance?.instanceId === instance.instanceId ? localWaInstance : undefined;
    const runtimeInstance = waInstance?.instance || {};
    const ownerJid = runtimeInstance.ownerJid || instance.ownerJid;
    const receiverNumber = selectChatwootPhysicalReceiverNumber({
      ownerJid,
      number: runtimeInstance.number || instance.number,
    });

    return buildChatwootEvoRouteBinding({
      inboxId,
      instanceId: runtimeInstance.id || waInstance?.instanceId || instance.instanceId,
      instanceName: runtimeInstance.name || instance.instanceName,
      receiverNumber,
      signingKey: provider.token,
    });
  }

  private inboxRouteBinding(inboxRecord: inbox): ChatwootEvoRouteBinding | null {
    const additionalAttributes = (inboxRecord as any)?.additional_attributes;
    const binding = additionalAttributes?.we_digital_route_binding;
    return binding && typeof binding === 'object' ? (binding as ChatwootEvoRouteBinding) : null;
  }

  private async reconcileChatwootRouteBinding(
    instance: InstanceDto,
    provider: ChatwootModel,
    inboxRecord: inbox,
    allowRebind: boolean,
  ): Promise<inbox> {
    const expectedBinding = this.buildEvoRouteBinding(instance, provider, inboxRecord.id);
    if (!expectedBinding) {
      this.logger.warn(`Chatwoot route unavailable for ${instance.instanceName}`);
      return inboxRecord;
    }

    const currentBinding = this.inboxRouteBinding(inboxRecord);
    if (chatwootEvoRouteBindingsEqual(currentBinding, expectedBinding)) return inboxRecord;

    if (currentBinding && !allowRebind) {
      this.logger.warn(`Chatwoot route changed for ${instance.instanceName}; explicit integration update required`);
      return inboxRecord;
    }

    const additionalAttributes = {
      ...((inboxRecord as any)?.additional_attributes || {}),
      we_digital_provider: 'evo_whatsapp',
      we_digital_provider_contract_version: expectedBinding.version,
      we_digital_route_binding: expectedBinding,
    };

    try {
      await axios.patch(
        `${provider.url}/api/v1/accounts/${provider.accountId}/inboxes/${inboxRecord.id}`,
        { channel: { additional_attributes: additionalAttributes } },
        {
          headers: { 'api-access-token': provider.token },
          timeout: 20_000,
        },
      );
      return { ...inboxRecord, additional_attributes: additionalAttributes } as inbox;
    } catch (error) {
      this.logger.error(`Failed to bind Chatwoot route for ${instance.instanceName}: ${formatCaughtError(error)}`);
      return inboxRecord;
    }
  }

  private async ingressAttributes(
    instance: InstanceDto,
    provider: ChatwootModel,
    messageBody: any,
    clientSent = false,
  ) {
    const inboxRecord = await this.getInbox(instance);
    const expectedBinding = inboxRecord ? this.buildEvoRouteBinding(instance, provider, inboxRecord.id) : null;
    const storedBinding = inboxRecord ? this.inboxRouteBinding(inboxRecord) : null;
    const route = chatwootEvoRouteBindingsEqual(storedBinding, expectedBinding) ? expectedBinding : null;

    return buildChatwootIngressAttributes(messageBody, route, clientSent);
  }

  public async getInbox(instance: InstanceDto, allowRebind = false): Promise<inbox | null> {
    const provider = await this.getProvider(instance);
    if (!provider) {
      this.logger.warn('provider not found');
      return null;
    }

    const cacheKey = chatwootInboxCacheKey(instance.instanceName, provider);
    if (await this.cache.has(cacheKey)) {
      const cachedInbox = (await this.cache.get(cacheKey)) as inbox;
      if (cachedInbox?.name === provider.nameInbox) {
        const reconciledInbox = await this.reconcileChatwootRouteBinding(instance, provider, cachedInbox, allowRebind);
        this.cache.set(cacheKey, reconciledInbox);
        return reconciledInbox;
      }
      await this.cache.delete(cacheKey);
    }

    const client = new ChatwootClient({
      config: this.getClientCwConfig(provider),
    });

    const inboxList = (await client.inboxes.list({
      accountId: Number(provider.accountId),
    })) as any;

    if (!Array.isArray(inboxList?.payload)) {
      this.logger.warn('inbox not found');
      return null;
    }

    const findByName = selectUniqueChatwootInbox(inboxList.payload, provider.nameInbox);

    if (!findByName) {
      const matchingInboxes = inboxList.payload.filter((candidate) => candidate.name === provider.nameInbox).length;
      this.logger.warn(`Expected one Chatwoot inbox for ${instance.instanceName}, found ${matchingInboxes}`);
      return null;
    }

    const reconciledInbox = await this.reconcileChatwootRouteBinding(instance, provider, findByName, allowRebind);
    this.cache.set(cacheKey, reconciledInbox);
    return reconciledInbox;
  }

  public async createMessage(
    instance: InstanceDto,
    conversationId: number,
    content: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    privateMessage?: boolean,
    attachments?: {
      content: unknown;
      encoding: string;
      filename: string;
    }[],
    messageBody?: any,
    sourceId?: string,
    quotedMsg?: MessageModel,
    clientSent = false,
  ) {
    const context = await this.clientCw(instance);

    if (!context) {
      this.logger.warn('client not found');
      return null;
    }
    const { client, provider } = context;

    const replyToIds = await this.getReplyToIds(messageBody, instance);

    const sourceReplyId = quotedMsg?.chatwootMessageId || null;

    const ingressAttributes = await this.ingressAttributes(instance, provider, messageBody, clientSent);
    const message = await client.messages.create({
      accountId: Number(provider.accountId),
      conversationId: conversationId,
      data: {
        content: content,
        message_type: messageType,
        attachments: attachments,
        private: privateMessage || false,
        source_id: sourceId,
        content_attributes: {
          ...replyToIds,
          ...ingressAttributes,
        },
        source_reply_id: sourceReplyId ? sourceReplyId.toString() : null,
      },
    });

    if (!message) {
      this.logger.warn('message not found');
      return null;
    }

    await this.bindInboundChatwootMessageId(sourceId, message, instance, conversationId);

    return message;
  }

  public async getOpenConversationByContact(
    instance: InstanceDto,
    inbox: inbox,
    contact: generic_id & contact,
  ): Promise<conversation> {
    const context = await this.clientCw(instance);

    if (!context) {
      this.logger.warn('client not found');
      return null;
    }
    const { client, provider } = context;

    const conversations = (await client.contacts.listConversations({
      accountId: Number(provider.accountId),
      id: contact.id,
    })) as any;

    return (
      conversations.payload.find(
        (conversation) => conversation.inbox_id === inbox.id && conversation.status === 'open',
      ) || undefined
    );
  }

  public async createBotMessage(
    instance: InstanceDto,
    content: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    attachments?: {
      content: unknown;
      encoding: string;
      filename: string;
    }[],
  ) {
    const context = await this.clientCw(instance);

    if (!context) {
      this.logger.warn('client not found');
      return null;
    }
    const { client, provider } = context;

    const contact = await this.findContact(instance, '123456');

    if (!contact) {
      this.logger.warn('contact not found');
      return null;
    }

    const filterInbox = await this.getInbox(instance);

    if (!filterInbox) {
      this.logger.warn('inbox not found');
      return null;
    }

    const conversation = await this.getOpenConversationByContact(instance, filterInbox, contact);

    if (!conversation) {
      this.logger.warn('conversation not found');
      return;
    }

    const message = await client.messages.create({
      accountId: Number(provider.accountId),
      conversationId: conversation.id,
      data: {
        content: content,
        message_type: messageType,
        attachments: attachments,
      },
    });

    if (!message) {
      this.logger.warn('message not found');
      return null;
    }

    return message;
  }

  private async sendData(
    conversationId: number,
    fileStream: Readable,
    fileName: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    content?: string,
    instance?: InstanceDto,
    messageBody?: any,
    sourceId?: string,
    quotedMsg?: MessageModel,
    provider?: ChatwootModel,
    clientSent = false,
    recovery?: {
      inboxId: number;
      timestamp: number;
      peer: string;
      mimetype: string;
      size: number;
      sha256: string;
      mediaType: string;
      nativeSource?: { message_type: string; sha256: string };
    },
  ) {
    if (sourceId && this.isImportHistoryAvailable()) {
      const messageAlreadySaved = await chatwootImport.getExistingSourceIds([sourceId], conversationId);
      if (messageAlreadySaved) {
        if (messageAlreadySaved.size > 0) {
          if (recovery) throw new Error('cached_media_destination_rotated_before_import');
          this.logger.warn('Message already saved on chatwoot');
          return null;
        }
      }
    }
    const data = new FormData();

    if (content) {
      data.append('content', content);
    }

    data.append('message_type', messageType);

    data.append('attachments[]', fileStream, {
      filename: fileName,
      ...(recovery ? { contentType: recovery.mimetype } : {}),
    });

    let expectedContentAttributes: Record<string, unknown> = {};
    const sourceReplyId = quotedMsg?.chatwootMessageId || null;

    if (!provider) {
      this.logger.warn('provider not found');
      return null;
    }

    if (messageBody && instance) {
      const replyToIds = await this.getReplyToIds(messageBody, instance);
      const ingressAttributes = await this.ingressAttributes(instance, provider, messageBody, clientSent);
      const contentAttributes = JSON.stringify({
        ...replyToIds,
        ...ingressAttributes,
        ...(recovery
          ? {
              provider_history_native: {
                message_id: messageBody.id,
                from_me: messageBody.key.fromMe,
                remote_jid: messageBody.key.remoteJid,
                participant: messageBody.key.participant ?? messageBody.participant ?? null,
                participant_alt: messageBody.key.participantAlt ?? null,
                push_name: messageBody.pushName ?? null,
                ...(recovery.nativeSource ? { source: recovery.nativeSource } : {}),
                ...(messageBody.message?.templateMessage
                  ? { template: retainedTemplate(messageBody.message).metadata }
                  : {}),
              },
            }
          : {}),
      });
      expectedContentAttributes = JSON.parse(contentAttributes);
      data.append('content_attributes', contentAttributes);
    }

    if (sourceReplyId) {
      data.append('source_reply_id', sourceReplyId.toString());
    }

    if (sourceId) {
      data.append('source_id', sourceId);
    }

    if (recovery) {
      if (!['incoming', 'outgoing'].includes(messageType) || !instance || !sourceId || !provider)
        throw new Error('cached_media_silent_import_unavailable');
      data.append('external_created_at', String(recovery.timestamp));
      data.append('private', 'false');
      data.append('provider_peer', recovery.peer);
      data.append('provider_file_sha256', recovery.sha256);
      data.append('provider_file_bytes', String(recovery.size));
      data.append('provider_media_type', recovery.mediaType);
      data.append('provider_instance_id', instance.instanceId || messageBody.instanceId);
      data.append('provider_instance_name', instance.instanceName);
      const binding = await this.assertSilentHistoryMediaCapability(instance, provider, recovery.inboxId);
      data.append('provider_receiver_fingerprint', binding.receiver_fingerprint);
    }
    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: recovery
        ? requireTrustedChatwootUrl(
            provider.url,
            this.configService.get<Chatwoot>('CHATWOOT').TRUSTED_BASE_URL,
            `/api/v1/accounts/${provider.accountId}/conversations/${conversationId}/messages`,
          )
        : `${provider.url}/api/v1/accounts/${provider.accountId}/conversations/${conversationId}/messages`,
      ...(recovery ? { timeout: 30_000, maxRedirects: 0 } : {}),
      headers: {
        'api-access-token': provider.token,
        ...(recovery
          ? {
              'X-Chatwoot-Native-Bridge-Token': this.configService.get<Chatwoot>('CHATWOOT').NATIVE_BRIDGE_TOKEN,
              'X-Chatwoot-History-Import': '1',
              'X-Chatwoot-History-Inbox-Id': String(recovery.inboxId),
            }
          : {}),
        ...data.getHeaders(),
      },
      data: data,
    };

    try {
      const { data } = await axios.request(config);

      if (!recovery) await this.bindInboundChatwootMessageId(sourceId, data, instance, conversationId);

      return recovery ? { message: data, expectedContentAttributes } : data;
    } catch (error) {
      if (recovery) throw new Error('cached_media_import_write_outcome_unconfirmed');
      this.logger.error(error);
    }
  }

  private readCachedRecoveryObject(name: string, limit: number, mime: string) {
    return readStoredFile(name, limit, mime);
  }

  private async readRecoveryMedia(message: MessageModel, provider: ChatwootModel): Promise<Buffer> {
    const key = message.key as { id?: string; remoteJid?: string };
    if (isGroupJid(key.remoteJid || '') && key.id) {
      if (!provider.accountId || !provider.url) throw new Error('cached_media_retained_account_unavailable');
      // Reuse authenticated stored bytes from the same group in this account before a provider download.
      const routes = await this.prismaRepository.chatwoot.findMany({
        where: { enabled: true, accountId: provider.accountId, url: provider.url },
        select: { instanceId: true },
      });
      if (routes.length > 100) throw new Error('cached_media_retained_route_limit');
      const candidates = await this.prismaRepository.message.findMany({
        where: {
          instanceId: { in: routes.map((route) => route.instanceId) },
          messageType: message.messageType,
          messageTimestamp: message.messageTimestamp,
          AND: [{ key: { path: ['id'], equals: key.id } }, { key: { path: ['remoteJid'], equals: key.remoteJid } }],
          Media: { isNot: null },
        },
        include: { Media: true },
        take: 26,
        orderBy: { id: 'asc' },
      });
      const bytes = await readRetainedGroupMedia(
        message,
        candidates.flatMap(({ Media, ...source }) => (Media ? [{ message: source, media: Media }] : [])),
        async (name, limit, mime) => this.readCachedRecoveryObject(name, limit, mime),
      );
      if (bytes) {
        const current = await this.prismaRepository.message.findMany({
          where: { id: { in: candidates.map((candidate) => candidate.id) } },
          include: { Media: true },
          orderBy: { id: 'asc' },
        });
        if (!isDeepStrictEqual(current, candidates)) throw new Error('cached_media_retained_source_rotated');
        return bytes;
      }
      if (
        [
          'videoMessage',
          'documentMessage',
          'imageMessage',
          'audioMessage',
          'stickerMessage',
          'associatedChildMessage',
        ].includes(message.messageType)
      ) {
        const retained = await this.readRecoveryChatwootVideo(
          message,
          provider,
          routes.map((route) => route.instanceId),
        );
        if (retained) return retained;
      }
    }
    return readRetainedRecoveryMedia(message);
  }

  private async readRecoveryChatwootVideo(message: MessageModel, provider: ChatwootModel, instanceIds: string[]) {
    const key = message.key as { id: string; remoteJid: string };
    const readNatives = () =>
      this.prismaRepository.message.findMany({
        where: {
          instanceId: { in: instanceIds },
          AND: [{ key: { path: ['id'], equals: key.id } }, { key: { path: ['remoteJid'], equals: key.remoteJid } }],
        },
        take: 26,
        orderBy: { id: 'asc' },
      });
    const nativeCandidates = await readNatives();
    const readCopies = async () =>
      (
        await postgresClient.getChatwootConnection().query(
          `SELECT m.id,m.account_id,m.inbox_id,m.source_id,m.message_type,m.private,
             extract(epoch from m.created_at)::double precision AS created_at_epoch,c.display_id,
             b.peer,ch.additional_attributes->'we_digital_route_binding'->>'instance_id' AS instance_id,
             a.id AS attachment_id,bl.id::text AS blob_id,bl.key,bl.byte_size::text,bl.content_type,bl.checksum
           FROM messages m JOIN conversations c ON c.id=m.conversation_id
             AND c.account_id=m.account_id AND c.inbox_id=m.inbox_id
           JOIN provider_conversation_bindings b ON b.conversation_id=c.id
             AND b.account_id=c.account_id AND b.inbox_id=c.inbox_id AND b.provider='whatsapp'
           JOIN contacts ct ON ct.id=c.contact_id AND ct.account_id=c.account_id
           JOIN contact_inboxes ci ON ci.id=c.contact_inbox_id AND ci.contact_id=ct.id AND ci.inbox_id=c.inbox_id
           JOIN inboxes i ON i.id=c.inbox_id AND i.account_id=c.account_id AND i.channel_type='Channel::Api'
           JOIN channel_api ch ON ch.id=i.channel_id AND ch.account_id=c.account_id
           JOIN attachments a ON a.message_id=m.id AND a.account_id=m.account_id
           JOIN active_storage_attachments sa ON sa.record_type='Attachment' AND sa.record_id=a.id AND sa.name='file'
           JOIN active_storage_blobs bl ON bl.id=sa.blob_id
           WHERE m.account_id=$1 AND m.source_id=ANY($2::text[]) AND b.peer=$3 AND ct.identifier=$3
             AND ch.additional_attributes->>'we_digital_provider'='evo_whatsapp'
             AND ch.additional_attributes->'we_digital_route_binding'->>'instance_id'=ANY($4::text[])
           ORDER BY m.id,a.id LIMIT 26`,
          [Number(provider.accountId), [key.id, toChatwootSourceId(key.id)], key.remoteJid, instanceIds],
        )
      ).rows as RetainedChatwootVideo[];
    const copies = await readCopies();
    const trusted = this.configService.get<Chatwoot>('CHATWOOT');
    const bytes = await readRetainedChatwootGroupVideo(
      message,
      nativeCandidates,
      copies,
      Number(provider.accountId),
      async (copy, limit) => {
        const response = await axios.request({
          method: 'GET',
          url: requireTrustedChatwootUrl(
            provider.url,
            trusted.TRUSTED_BASE_URL,
            `/api/v1/accounts/${provider.accountId}/conversations/${copy.display_id}/messages`,
          ),
          params: { source_ids: [copy.source_id] },
          headers: {
            'api-access-token': provider.token,
            'X-Chatwoot-Native-Bridge-Token': trusted.NATIVE_BRIDGE_TOKEN,
          },
          timeout: 15_000,
          maxRedirects: 0,
          maxContentLength: 1024 * 1024,
        });
        const url = retainedVideoProxyUrl(copy, response.data?.payload, new URL(trusted.TRUSTED_BASE_URL).origin);
        const stored = await axios.request({
          method: 'GET',
          url,
          responseType: 'arraybuffer',
          timeout: 15_000,
          maxRedirects: 0,
          maxContentLength: limit,
        });
        if (stored.headers['content-type']?.split(';')[0] !== copy.content_type)
          throw new Error('retained_cw_video_response_mime');
        return Buffer.from(stored.data);
      },
    );
    if (!bytes) return null;
    const current = await readNatives();
    const currentRoutes = await this.prismaRepository.chatwoot.findMany({
      where: { enabled: true, accountId: provider.accountId, url: provider.url },
      select: { instanceId: true },
    });
    if (
      !isDeepStrictEqual(current, nativeCandidates) ||
      !isDeepStrictEqual(await readCopies(), copies) ||
      !isDeepStrictEqual(currentRoutes.map((route) => route.instanceId).sort(), [...instanceIds].sort())
    )
      throw new Error('retained_cw_video_source_rotated');
    return bytes;
  }

  private async assertSilentHistoryMediaCapability(instance: InstanceDto, provider: ChatwootModel, inboxId: number) {
    const payload = await this.providerConversationRequest(provider, 'GET', { inbox_id: inboxId });
    const binding = this.buildEvoRouteBinding(instance, provider, inboxId);
    if (
      payload?.enabled !== true ||
      payload?.provider !== 'whatsapp' ||
      payload?.whatsapp_history_import_contract_version !== 1 ||
      !binding ||
      !chatwootEvoRouteBindingsEqual(binding, payload.binding)
    )
      throw new Error('cached_media_silent_import_unavailable');
    return binding;
  }

  private async assertTaggedHistoryMediaStored(
    messages: MessageModel[],
    instance: InstanceDto,
    provider: ChatwootModel,
    inboxId: number,
    requiredSources = new Set<string>(),
  ) {
    if (!messages.length) return new Set<string>();
    const bySource = new Map(
      messages.map((message) => [toChatwootSourceId((message.key as { id: string }).id), message]),
    );
    const aliases = Array.from(bySource.keys()).flatMap((source) => [source, source.substring(5)]);
    const query = await postgresClient.getChatwootConnection().query(
      `SELECT m.id, m.source_id, m.message_type, m.private, m.created_at, extract(epoch from m.created_at)::double precision AS created_at_epoch, c.display_id, a.id AS attachment_id,
         a.meta AS attachment_meta, a.file_type, b.byte_size, pc.peer
       FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.account_id=m.account_id AND c.inbox_id=m.inbox_id
       JOIN attachments a ON a.message_id=m.id AND a.account_id=m.account_id
       JOIN active_storage_attachments sa ON sa.record_type='Attachment' AND sa.record_id=a.id AND sa.name='file'
       JOIN active_storage_blobs b ON b.id=sa.blob_id
       JOIN provider_conversation_bindings pc ON pc.conversation_id=c.id AND pc.account_id=c.account_id
         AND pc.inbox_id=c.inbox_id AND pc.provider='whatsapp'
       WHERE m.account_id=$1 AND m.inbox_id=$2 AND m.source_id=ANY($3::text[]) AND a.meta ? 'whatsapp_history_sha256'`,
      [Number(provider.accountId), inboxId, aliases],
    );
    const seen = new Set<string>();
    for (const row of query.rows) {
      const sourceId = toChatwootSourceId(row.source_id);
      const message = bySource.get(sourceId);
      const sha256 = row.attachment_meta?.whatsapp_history_sha256;
      const mediaType = message ? cachedHistoryMediaType(message) : undefined;
      const nativeMedia = message ? nativeCachedMediaPayload(message) : null;
      const nativePeers = message ? Array.from(chatwootImport.createMessagesMapByIdentity([message]).keys()) : [];
      if (
        !message ||
        seen.has(sourceId) ||
        !/^[0-9a-f]{64}$/.test(sha256) ||
        !['image', 'audio', 'video', 'document'].includes(mediaType) ||
        row.attachment_meta?.whatsapp_history_media_type !== mediaType ||
        !nativeMedia ||
        nativeMedia.digest.toString('hex') !== sha256 ||
        nativeMedia.size !== Number(row.byte_size) ||
        nativePeers.length !== 1 ||
        nativePeers[0] !== row.peer ||
        !Number.isSafeInteger(Number(row.byte_size)) ||
        Number(row.byte_size) < 1 ||
        Number(row.byte_size) > CACHED_MEDIA_FILE_LIMIT ||
        typeof (message.key as any).fromMe !== 'boolean' ||
        Number(row.message_type) !== ((message.key as any).fromMe ? 1 : 0) ||
        row.private !== false ||
        typeof row.created_at_epoch !== 'number' ||
        !Number.isFinite(row.created_at_epoch) ||
        Math.floor(row.created_at_epoch) !== message.messageTimestamp ||
        !Number.isSafeInteger(Number(row.display_id)) ||
        Number(row.display_id) < 1 ||
        typeof row.peer !== 'string' ||
        !row.peer
      )
        throw new Error('cached_media_tagged_destination_unconfirmed');
      seen.add(sourceId);
      await this.verifyTaggedMediaStorageProof(instance, provider, inboxId, message, row, mediaType, sha256);
    }
    if ([...requiredSources].some((source) => !seen.has(source)))
      throw new Error('cached_media_tagged_destination_rotated');
    return seen;
  }

  private async verifyTaggedMediaStorageProof(
    instance: InstanceDto,
    provider: ChatwootModel,
    inboxId: number,
    message: MessageModel,
    row: any,
    mediaType: string,
    sha256: string,
  ) {
    const binding = await this.assertSilentHistoryMediaCapability(instance, provider, inboxId);
    let proof: any;
    try {
      const response = await axios.request({
        method: 'GET',
        maxRedirects: 0,
        timeout: 15_000,
        url: requireTrustedChatwootUrl(
          provider.url,
          this.configService.get<Chatwoot>('CHATWOOT').TRUSTED_BASE_URL,
          `/api/v1/accounts/${provider.accountId}/inboxes/${inboxId}/conversations/${row.display_id}/messages/${row.id}`,
        ),
        headers: {
          'api-access-token': provider.token,
          'X-Chatwoot-Native-Bridge-Token': this.configService.get<Chatwoot>('CHATWOOT').NATIVE_BRIDGE_TOKEN,
        },
        params: {
          history_media_proof: '1',
          provider_instance_id: instance.instanceId || message.instanceId,
          provider_instance_name: instance.instanceName,
          provider_receiver_fingerprint: binding.receiver_fingerprint,
          provider_peer: row.peer,
          source_id: toChatwootSourceId((message.key as { id: string }).id),
          message_type: (message.key as any).fromMe ? 'outgoing' : 'incoming',
          private: 'false',
          external_created_at: String(message.messageTimestamp),
          provider_file_sha256: sha256,
          provider_file_bytes: String(row.byte_size),
          provider_media_type: mediaType,
        },
      });
      proof = response.data?.whatsapp_history_media_proof;
    } catch {
      throw new Error('cached_media_stored_bytes_unconfirmed');
    }
    if (
      proof?.verified !== true ||
      proof.message_id !== Number(row.id) ||
      proof.source_id !== toChatwootSourceId((message.key as { id: string }).id) ||
      proof.attachment_id !== Number(row.attachment_id) ||
      proof.sha256 !== sha256 ||
      proof.byte_size !== Number(row.byte_size) ||
      proof.media_type !== mediaType
    )
      throw new Error('cached_media_stored_bytes_unconfirmed');
  }

  private async verifyRecoveryMediaDestination(
    message: MessageModel,
    provider: ChatwootModel,
    inboxId: number,
    descriptor: { filename: string; mimetype: string; size: number; digest: Buffer },
    bytes: Buffer,
    expected: { conversationId: number; displayId: number; content: string; attributes: Record<string, unknown> },
  ) {
    const rows = await postgresClient.getChatwootConnection().query(
      `SELECT m.id, m.message_type, m.private, m.account_id, m.inbox_id, m.created_at, extract(epoch from m.created_at)::double precision AS created_at_epoch, m.content, m.content_attributes, c.id AS conversation_id, c.display_id,
         c.account_id AS conversation_account, c.inbox_id AS conversation_inbox,
         a.id AS attachment_id, a.meta AS attachment_meta, b.byte_size, b.content_type, b.filename, b.checksum
       FROM messages m JOIN conversations c ON c.id=m.conversation_id
       JOIN attachments a ON a.message_id=m.id AND a.account_id=m.account_id
       JOIN active_storage_attachments sa ON sa.record_type='Attachment' AND sa.record_id=a.id AND sa.name='file'
       JOIN active_storage_blobs b ON b.id=sa.blob_id
       WHERE m.inbox_id=$1 AND m.source_id=ANY($2::text[])`,
      [inboxId, [toChatwootSourceId((message.key as { id: string }).id), (message.key as { id: string }).id]],
    );
    const row = rows.rows[0];
    let contentAttributes: unknown = row?.content_attributes;
    try {
      if (typeof contentAttributes === 'string') contentAttributes = JSON.parse(contentAttributes);
    } catch {
      throw new Error('cached_media_import_postimage_unconfirmed');
    }
    if (
      !contentAttributes ||
      typeof contentAttributes !== 'object' ||
      Array.isArray(contentAttributes) ||
      Object.getPrototypeOf(contentAttributes) !== Object.prototype
    )
      throw new Error('cached_media_import_postimage_unconfirmed');
    if (
      rows.rows.length !== 1 ||
      Number(row.message_type) !== ((message.key as { fromMe: boolean }).fromMe ? 1 : 0) ||
      row.private !== false ||
      Number(row.account_id) !== Number(provider.accountId) ||
      Number(row.conversation_account) !== Number(provider.accountId) ||
      Number(row.conversation_inbox) !== inboxId ||
      Number(row.byte_size) !== bytes.length ||
      Number(row.conversation_id) !== expected.conversationId ||
      Number(row.display_id) !== expected.displayId ||
      row.content !== (expected.content || null) ||
      Object.entries(expected.attributes).some(
        ([key, value]) => !isDeepStrictEqual((contentAttributes as Record<string, unknown>)[key], value),
      ) ||
      row.attachment_meta?.whatsapp_history_sha256 !== descriptor.digest.toString('hex') ||
      row.attachment_meta?.whatsapp_history_media_type !== cachedHistoryMediaType(message) ||
      (!cachedMediaMIMEsEqual(retainedHistoryMedia(message).type, descriptor.mimetype, row.content_type) &&
        !(
          message.messageType === 'lottieStickerMessage' &&
          descriptor.mimetype === 'application/was' &&
          row.content_type === 'application/zip'
        )) ||
      row.filename !== descriptor.filename ||
      row.checksum !== createHash('md5').update(bytes).digest('base64') ||
      typeof row.created_at_epoch !== 'number' ||
      !Number.isFinite(row.created_at_epoch) ||
      Math.floor(row.created_at_epoch) !== message.messageTimestamp
    )
      throw new Error('cached_media_import_postimage_unconfirmed');
  }

  public async createBotQr(
    instance: InstanceDto,
    content: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    fileStream?: Readable,
    fileName?: string,
  ) {
    const context = await this.clientCw(instance);

    if (!context) {
      this.logger.warn('client not found');
      return null;
    }
    const { provider } = context;

    if (!this.configService.get<Chatwoot>('CHATWOOT').BOT_CONTACT) {
      this.logger.log('Chatwoot bot contact is disabled');

      return true;
    }

    const contact = await this.findContact(instance, '123456');

    if (!contact) {
      this.logger.warn('contact not found');
      return null;
    }

    const filterInbox = await this.getInbox(instance);

    if (!filterInbox) {
      this.logger.warn('inbox not found');
      return null;
    }

    const conversation = await this.getOpenConversationByContact(instance, filterInbox, contact);

    if (!conversation) {
      this.logger.warn('conversation not found');
      return;
    }

    const data = new FormData();

    if (content) {
      data.append('content', content);
    }

    data.append('message_type', messageType);

    if (fileStream && fileName) {
      data.append('attachments[]', fileStream, { filename: fileName });
    }

    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: `${provider.url}/api/v1/accounts/${provider.accountId}/conversations/${conversation.id}/messages`,
      headers: {
        'api-access-token': provider.token,
        ...data.getHeaders(),
      },
      data: data,
    };

    try {
      const { data } = await axios.request(config);

      return data;
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async sendAttachment(
    waInstance: any,
    number: string,
    media: any,
    caption?: string,
    options?: Options,
    provenance?: OutboundMessageProvenance,
  ) {
    try {
      const metadata = await resolveChatwootAttachmentMetadata(media, async () => {
        const response = await axios.get(media, {
          responseType: 'arraybuffer',
          signal: options?.signal,
        });
        return response.headers['content-type'];
      });
      const fileName = metadata.fileName || 'document';
      const mimeType = metadata.mimetype || '';

      const parsedMedia = path.parse(fileName);

      let type = 'document';

      switch (mimeType.split('/')[0]) {
        case 'image':
          type = 'image';
          break;
        case 'video':
          type = 'video';
          break;
        case 'audio':
          type = 'audio';
          break;
        default:
          type = 'document';
          break;
      }

      if (type === 'audio') {
        const data: SendAudioDto = {
          number: number,
          audio: media,
          delay: Math.floor(Math.random() * (2000 - 500 + 1)) + 500,
          quoted: options?.quoted,
          messageId: options?.messageId,
          beforeTransport: options?.beforeTransport,
          signal: options?.signal,
        };

        sendTelemetry('/message/sendWhatsAppAudio');

        const messageSent = await waInstance?.audioWhatsapp(data, null, true, provenance);

        return messageSent;
      }

      const documentExtensions = ['.gif', '.svg', '.tiff', '.tif', '.dxf', '.dwg'];
      if (type === 'image' && parsedMedia && documentExtensions.includes(parsedMedia?.ext)) {
        type = 'document';
      }

      const data: SendMediaDto = {
        number: number,
        mediatype: type as any,
        fileName: fileName,
        mimetype: mimeType || undefined,
        media: media,
        delay: 1200,
        quoted: options?.quoted,
        messageId: options?.messageId,
        beforeTransport: options?.beforeTransport,
        signal: options?.signal,
      };

      sendTelemetry('/message/sendMedia');

      if (caption) {
        data.caption = caption;
      }

      const messageSent = await waInstance?.mediaMessage(data, null, true, provenance);

      return messageSent;
    } catch (error) {
      if (options?.signal?.aborted) {
        const aborted = new Error('Outbound operation aborted during attachment preparation');
        aborted.name = 'OutboundOperationAborted';
        throw aborted;
      }
      this.logger.error(
        JSON.stringify({ event: 'chatwoot_attachment_send_error', errorClass: error?.name || 'Error' }),
      );
      throw error; // Re-throw para que o erro seja tratado pelo caller
    }
  }

  private normalizeChatwootBaseUrl(url: string) {
    return url.replace(/\/+$/, '');
  }

  private outboundBindingMismatch() {
    const error = new Error('Chatwoot outbound origin or route binding changed');
    error.name = 'OutboundBindingMismatch';
    return error;
  }

  private outboundMessageDeleted() {
    const error = new Error('Chatwoot outbound message was authoritatively deleted');
    error.name = 'OutboundMessageDeleted';
    return error;
  }

  private async outboundInstance(operation: StoredChatwootOutboundOperation): Promise<InstanceDto | null> {
    const stored = await this.prismaRepository.instance.findUnique({
      where: { id: operation.instanceId },
      select: { id: true, name: true, ownerJid: true, number: true },
    });
    return stored
      ? {
          instanceId: stored.id,
          instanceName: stored.name,
          ownerJid: stored.ownerJid,
          number: stored.number,
        }
      : null;
  }

  private async awaitCancelable<T>(request: Promise<T> & { cancel?: () => void }, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      request.cancel?.();
      const error = new Error('Outbound operation aborted');
      error.name = 'OutboundOperationAborted';
      throw error;
    }
    const cancel = () => request.cancel?.();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      let result: T;
      try {
        result = await request;
      } catch (error) {
        if (!signal.aborted) throw error;
        const aborted = new Error('Outbound operation aborted');
        aborted.name = 'OutboundOperationAborted';
        throw aborted;
      }
      if (signal.aborted) {
        const error = new Error('Outbound operation aborted');
        error.name = 'OutboundOperationAborted';
        throw error;
      }
      return result;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  private async currentOutboundContext(
    operation: StoredChatwootOutboundOperation,
    signal: AbortSignal,
    expectedDeleted = false,
    allowAuthoritativeDeletion = false,
  ) {
    const instance = await this.outboundInstance(operation);
    if (!instance) return null;
    const localWaInstance = this.waMonitor.waInstances[instance.instanceName];
    const waInstance = localWaInstance?.instanceId === operation.instanceId ? localWaInstance : null;
    const provider = await this.prismaRepository.chatwoot.findUnique({ where: { instanceId: operation.instanceId } });
    if (
      !provider?.id ||
      provider.enabled !== true ||
      !provider.url ||
      !provider.token ||
      !provider.accountId ||
      !provider.nameInbox
    )
      return null;

    const origin = operation.payload.origin;
    const expectedRoute = this.buildEvoRouteBinding(instance, provider, origin.inboxId);
    if (origin.routeBinding.instance_name !== instance.instanceName) {
      return null;
    }

    const client = new ChatwootClient({ config: this.getClientCwConfig(provider) });
    const exactMessageResponse = await this.awaitCancelable(
      getExactChatwootMessage(
        this.getClientCwConfig(provider),
        origin.accountId,
        origin.inboxId,
        origin.conversationId,
        origin.messageId,
      ) as any,
      signal,
    );
    const currentMessage = unwrapChatwootPayload(exactMessageResponse);
    // Only a destination mismatch needs the compatibility read. The prior
    // Chatwoot image fingerprints raw opaque labels; the fresh conversation
    // verifies the current phone before an EVO-first production cutover sends.
    const legacyDestinationCandidate =
      typeof currentMessage?.destination === 'string' &&
      currentMessage.destination.length > 0 &&
      currentMessage.destination !== operation.payload.chatId;
    const currentConversation = legacyDestinationCandidate
      ? unwrapChatwootPayload(
          await this.awaitCancelable(
            client.conversations.get({ accountId: origin.accountId, conversationId: origin.conversationId }) as any,
            signal,
          ),
        )
      : null;
    const snapshot = {
      operation,
      provider,
      currentInbox: null,
      conversation: null,
      currentMessage,
      currentConversation,
      expectedRoute,
      currentRoute: currentMessage?.route?.binding,
    };
    const exact = validatesCurrentChatwootOutboundSnapshot({ ...snapshot, expectedDeleted });
    const authoritativelyDeleted =
      !expectedDeleted &&
      allowAuthoritativeDeletion &&
      !exact &&
      validatesCurrentChatwootOutboundSnapshot({ ...snapshot, expectedDeleted: true });
    if (!exact && !authoritativelyDeleted) return null;

    return {
      instance,
      waInstance,
      provider,
      client,
      currentMessage,
      authoritativelyDeleted,
      providerContext: {
        snapshot_version: Number(currentMessage.outbound_snapshot.version),
        snapshot_fingerprint: String(currentMessage.outbound_snapshot.fingerprint),
        binding: currentMessage.route.binding,
      },
    };
  }

  private async prepareQueuedOutbound(operation: StoredChatwootOutboundOperation, signal: AbortSignal) {
    const context = await this.currentOutboundContext(operation, signal, false, true);
    if (!context) return { validation: 'mismatch' as const };
    return {
      validation: context.authoritativelyDeleted ? ('deleted' as const) : ('valid' as const),
      context,
    };
  }

  private async revalidateQueuedOutboundTransport(operation: StoredChatwootOutboundOperation, signal: AbortSignal) {
    const context = await this.currentOutboundContext(operation, signal, false, true);
    if (!context) return { validation: 'mismatch' as const };
    if (!context.waInstance || context.waInstance.connectionStatus?.state !== 'open') {
      throw Object.assign(new Error('WhatsApp socket is not ready'), { name: 'WhatsappNotReady' });
    }
    return {
      validation: context.authoritativelyDeleted ? ('deleted' as const) : ('valid' as const),
      providerContext: context.providerContext,
    };
  }

  private async validateOutboundBinding(
    operation: StoredChatwootOutboundOperation,
    phase: ChatwootOutboundPhase,
    signal: AbortSignal,
  ): Promise<'valid' | 'deleted' | 'mismatch'> {
    void phase;
    const context = await this.currentOutboundContext(operation, signal, false, true);
    if (!context) return 'mismatch';
    return context.authoritativelyDeleted ? 'deleted' : 'valid';
  }

  private async isOutboundReady(
    _operation: StoredChatwootOutboundOperation,
    preparedContext: unknown,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted)
      throw Object.assign(new Error('Outbound operation aborted'), { name: 'OutboundOperationAborted' });
    const context = preparedContext as Awaited<ReturnType<ChatwootService['currentOutboundContext']>>;
    if (context?.authoritativelyDeleted) throw this.outboundMessageDeleted();
    return context?.waInstance?.connectionStatus?.state === 'open';
  }

  private async sendQueuedOutbound(
    operation: StoredChatwootOutboundOperation,
    preparedContext: unknown,
    onTransportStart: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<{ whatsappMessageId: string; result: unknown }> {
    const context = preparedContext as Awaited<ReturnType<ChatwootService['currentOutboundContext']>>;
    if (!context) throw this.outboundBindingMismatch();
    if (context.authoritativelyDeleted) throw this.outboundMessageDeleted();
    const { instance, waInstance } = context;
    if (
      !waInstance ||
      waInstance.instanceId !== operation.instanceId ||
      waInstance.connectionStatus?.state !== 'open'
    ) {
      throw Object.assign(new Error('WhatsApp socket is not ready'), { name: 'WhatsappNotReady' });
    }

    const payload = operation.payload;
    const quoted = await this.getQuotedMessage(
      {
        content_attributes: {
          in_reply_to: payload.quotedChatwootMessageId,
          in_reply_to_external_id: payload.quotedWhatsappMessageId,
          quote_text: payload.quoteText,
        },
      },
      instance,
    );
    const provenance: OutboundMessageProvenance = {
      version: 1,
      origin: 'chatwoot',
      requestId: operation.operationKey,
      chatwootMessageId: payload.origin.messageId,
      chatwootInboxId: payload.origin.inboxId,
      chatwootConversationId: payload.origin.conversationId,
    };

    let messageSent: any;
    if (payload.nativeForward) {
      const stored = await this.resolveStoredForwardMessage(
        instance,
        payload.nativeForward.sourceChatwootMessageId,
        payload.nativeForward.sourceWhatsappMessageId
          ? `WAID:${payload.nativeForward.sourceWhatsappMessageId}`
          : undefined,
      );
      const key = stored?.key as WAMessageKey | undefined;
      const message = stored?.message as WAMessageContent | undefined;
      if (!key?.id || !message || !waInstance.nativeForwardMessage) {
        const error = new Error('Native WhatsApp forward source is unavailable');
        error.name = 'NativeForwardSourceMissing';
        throw error;
      }
      messageSent = await waInstance.nativeForwardMessage(
        payload.chatId,
        { key, message },
        {
          messageId: operation.plannedWhatsappMessageId,
          beforeTransport: onTransportStart,
          signal,
        },
      );
    } else if (payload.attachmentUrl) {
      messageSent = await this.sendAttachment(
        waInstance,
        payload.chatId,
        payload.attachmentUrl,
        payload.text,
        { quoted, messageId: operation.plannedWhatsappMessageId, beforeTransport: onTransportStart, signal },
        provenance,
      );
    } else {
      sendTelemetry('/message/sendText');
      messageSent = await waInstance.textMessage(
        {
          number: payload.chatId,
          text: payload.text,
          quoted,
          messageId: operation.plannedWhatsappMessageId,
          beforeTransport: onTransportStart,
          signal,
          mentioned: payload.mentioned,
        },
        true,
        provenance,
      );
    }

    const whatsappMessageId = messageSent?.key?.id;
    if (typeof whatsappMessageId !== 'string' || whatsappMessageId.length === 0) {
      throw new Error('MissingWhatsappMessageId');
    }
    if (whatsappMessageId !== operation.plannedWhatsappMessageId) {
      throw new Error('UnexpectedWhatsappMessageId');
    }
    return {
      whatsappMessageId,
      result: {
        key: messageSent.key,
        messageTimestamp: Long.isLong(messageSent?.messageTimestamp)
          ? messageSent.messageTimestamp.toNumber()
          : messageSent?.messageTimestamp,
        ...(payload.nativeForward ? { nativeForwardMessage: waInstance.prepareMessage(messageSent) } : {}),
      },
    };
  }

  private async confirmQueuedOutbound(
    operation: StoredChatwootOutboundOperation,
    callbackParts: ChatwootProviderDeliveryPart[],
    signal: AbortSignal,
  ) {
    const { origin } = operation.payload;
    const instance = await this.outboundInstance(operation);
    const provider = await this.prismaRepository.chatwoot.findUnique({ where: { instanceId: operation.instanceId } });
    if (!instance || !this.providerMatchesFrozenOutboundOrigin(provider, origin)) {
      throw this.outboundBindingMismatch();
    }
    if (operation.payload.nativeForward) {
      const messageRaw = (operation.result as any)?.nativeForwardMessage;
      if (!messageRaw?.key?.id) throw new Error('NativeForwardPersistencePayloadMissing');
      await persistNativeForwardMessage({
        repository: this.prismaRepository,
        instanceId: operation.instanceId,
        messageRaw,
      });
    }
    const expectedRoute = this.buildEvoRouteBinding(instance, provider, origin.inboxId);
    if (!chatwootEvoRouteBindingsEqual(expectedRoute, origin.routeBinding)) throw this.outboundBindingMismatch();
    let providerContext = operation.callbackContext as ChatwootProviderContext | undefined;
    if (!this.validCallbackProviderContext(providerContext, origin.routeBinding)) {
      const legacyContext = await this.currentOutboundContext(operation, signal, false, true);
      if (!legacyContext) throw this.outboundBindingMismatch();
      if (legacyContext.authoritativelyDeleted) throw this.outboundMessageDeleted();
      providerContext = legacyContext.providerContext as ChatwootProviderContext;
    }
    for (const callbackPart of callbackParts) {
      const update = buildChatwootDeliverySuccessUpdate(
        origin.accountId,
        origin.conversationId,
        origin.messageId,
        callbackPart.sourceId,
        callbackPart,
        providerContext,
      );
      let response: any;
      try {
        response = await this.updateQueuedOutboundMessage(provider, update, signal);
      } catch (error) {
        this.throwConditionalCallbackOutcome(error);
      }
      if (!isChatwootProviderDeliveryAcknowledged(response, origin.messageId, callbackPart, callbackParts)) {
        const error = new Error('Chatwoot provider-delivery callback was not acknowledged');
        error.name = 'ChatwootProviderDeliveryCallbackNotAcknowledged';
        throw error;
      }
      const persisted = await this.persistLocalChatwootMessageBinding(
        callbackPart.sourceId,
        {
          messageId: origin.messageId,
          inboxId: origin.inboxId,
          conversationId: origin.conversationId,
          contactInboxSourceId: origin.contactInboxSourceId,
        },
        instance,
        callbackParts,
      );
      if (persisted !== 1) throw new Error('LocalWhatsappMessageNotAcknowledged');
    }
  }

  private providerMatchesFrozenOutboundOrigin(provider: any, origin: ChatwootOutboundOrigin): boolean {
    const accountId = Number(provider?.accountId);
    return Boolean(
      provider?.enabled === true &&
        provider?.id === origin.providerId &&
        typeof provider?.url === 'string' &&
        typeof provider?.token === 'string' &&
        provider.token.length > 0 &&
        Number.isSafeInteger(accountId) &&
        accountId === origin.accountId &&
        this.normalizeChatwootBaseUrl(provider.url) === this.normalizeChatwootBaseUrl(origin.baseUrl) &&
        provider?.nameInbox === origin.inboxName,
    );
  }

  private async updateQueuedOutboundMessage(
    provider: any,
    update: ReturnType<typeof buildChatwootDeliverySuccessUpdate>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.awaitCancelable(
      updateChatwootMessageJson(
        this.getClientCwConfig(provider),
        update.accountId,
        update.conversationId,
        update.messageId,
        update.data,
      ) as any,
      signal,
    );
  }

  private validCallbackProviderContext(
    context: ChatwootProviderContext | undefined,
    binding: ChatwootEvoRouteBinding,
  ): context is ChatwootProviderContext {
    return Boolean(
      context?.snapshot_version === 1 &&
        /^[a-f0-9]{64}$/.test(context.snapshot_fingerprint) &&
        chatwootEvoRouteBindingsEqual(context.binding as ChatwootEvoRouteBinding, binding),
    );
  }

  private throwConditionalCallbackOutcome(error: unknown): never {
    const candidate = error as any;
    const status = Number(candidate?.status ?? candidate?.statusCode ?? candidate?.response?.status);
    const code = candidate?.body?.error ?? candidate?.response?.data?.error;
    if (status === 409 && code === 'provider_message_deleted') throw this.outboundMessageDeleted();
    if (status === 409 && (code === 'provider_binding_changed' || code === 'outbound_snapshot_mismatch')) {
      throw this.outboundBindingMismatch();
    }
    throw error;
  }

  private async failQueuedOutbound(operation: StoredChatwootOutboundOperation, signal: AbortSignal) {
    const context = await this.currentOutboundContext(operation, signal, false, true);
    if (!context) throw this.outboundBindingMismatch();
    if (context.authoritativelyDeleted) throw this.outboundMessageDeleted();
    const { origin } = operation.payload;
    const response: any = await this.awaitCancelable(
      context.client.messages.update(
        buildChatwootDeliveryFailureUpdate(origin.accountId, origin.conversationId, origin.messageId) as any,
      ) as any,
      signal,
    );
    if (!isChatwootDeliveryFailureAcknowledged(response, origin.messageId)) {
      throw new Error('ChatwootFailureCallbackNotAcknowledged');
    }
  }

  private outboundRemoteJidMatches(chatId: string, remoteJid: string): boolean {
    return remoteJid === chatId || remoteJid.split('@')[0] === chatId.split('@')[0];
  }

  private async deleteQueuedOutbound(
    operation: StoredChatwootOutboundOperation,
    signal: AbortSignal,
  ): Promise<'deleted' | 'waiting'> {
    const context = await this.currentOutboundContext(operation, signal, true);
    if (!context) throw this.outboundBindingMismatch();
    const sourceId = operation.whatsappMessageId || (await this.outboundStore.findSentMessageId(operation));
    if (!sourceId) return operation.sendAttempts === 0 ? 'deleted' : 'waiting';

    const message = await this.prismaRepository.message.findFirst({
      where: {
        instanceId: operation.instanceId,
        key: { path: ['id'], equals: sourceId },
      },
    });
    const key = message?.key as WAMessageKey | undefined;
    if (
      !message ||
      !key?.id ||
      !key.remoteJid ||
      !this.outboundRemoteJidMatches(operation.payload.chatId, key.remoteJid)
    ) {
      return 'waiting';
    }
    if (!validatesLocalChatwootDeletionBinding(message, operation)) throw this.outboundBindingMismatch();
    if (signal.aborted) {
      const error = new Error('Outbound operation aborted before deletion transport');
      error.name = 'OutboundOperationAborted';
      throw error;
    }
    await context.waInstance.client.sendMessage(key.remoteJid, { delete: key });
    return 'deleted';
  }

  private async enqueueChatwootOutbound(
    instance: InstanceDto,
    provider: ChatwootModel,
    routeBinding: ChatwootEvoRouteBinding,
    body: any,
    chatId: string,
    formattedText: string | null,
    admission: ChatwootOutboundWebhookHeaders,
    nativeForward?: {
      sourceChatwootMessageId: number;
      sourceWhatsappMessageId?: string;
    },
  ) {
    const contactIdentity = chatwootOutboundContactIdentity(body);
    const origin: ChatwootOutboundOrigin = {
      providerId: provider.id,
      baseUrl: this.normalizeChatwootBaseUrl(provider.url),
      accountId: Number(provider.accountId),
      inboxId: Number(body.inbox.id),
      conversationId: Number(body.conversation.id),
      messageId: Number(body.id),
      ...contactIdentity,
      inboxName: provider.nameInbox,
      snapshotFingerprint: String(body.outbound_snapshot?.fingerprint || ''),
      routeBinding,
    };
    const mentioned = extractWhatsappMentionJids(body);
    const parts = buildChatwootOutboundParts({
      instanceId: instance.instanceId,
      body,
      chatId,
      formattedText,
      origin,
      mentioned: mentioned.length ? mentioned : undefined,
      nativeForward,
    });
    const createdAtSeconds = Number(body.created_at);
    const messageCreatedAt =
      Number.isFinite(createdAtSeconds) && createdAtSeconds > 0 ? new Date(createdAtSeconds * 1_000) : undefined;
    const receivedAt = admission.receivedAt;
    const enqueueResult = await this.outboundStore.enqueue(
      instance.instanceId,
      Number(body.id),
      Number(body.inbox.id),
      Number(body.conversation.id),
      parts,
      {
        deliveryId: admission.deliveryId,
        receivedAt,
        messageCreatedAt,
        maxBacklog: this.configService.get<Chatwoot>('CHATWOOT').OUTBOUND_MAX_BACKLOG,
        maxOldestAgeMs: this.configService.get<Chatwoot>('CHATWOOT').OUTBOUND_MAX_OLDEST_AGE_MS,
      },
    );
    this.logger.verbose(
      JSON.stringify({
        event: 'chatwoot_outbound_admitted',
        recovered: enqueueResult.recovered,
        operationCount: parts.length,
        admissionMs: Date.now() - receivedAt.getTime(),
        backlogDepth: enqueueResult.backlog?.depth ?? null,
        oldestAgeMs: enqueueResult.backlog?.oldestAt
          ? Math.max(0, Date.now() - enqueueResult.backlog.oldestAt.getTime())
          : null,
      }),
    );
    this.outboundQueue.wake();
    return { accepted: true, operationCount: parts.length, recovered: enqueueResult.recovered };
  }

  public async onSendMessageError(instance: InstanceDto, conversation: number, messageId?: number, error?: any) {
    this.logger.verbose(JSON.stringify({ event: 'chatwoot_send_error_handler', errorClass: error?.name || 'Error' }));

    const context = await this.clientCw(instance);

    if (!context) {
      return;
    }
    const { client, provider } = context;

    if (messageId) {
      try {
        await client.messages.update(
          buildChatwootDeliveryFailureUpdate(Number(provider.accountId), conversation, messageId) as any,
        );
      } catch (statusError) {
        this.logger.error(
          JSON.stringify({
            event: 'chatwoot_delivery_failure_callback_error',
            errorClass: statusError?.name || 'Error',
          }),
        );
      }
    }

    if (error && error?.status === 400 && error?.message[0]?.exists === false) {
      await client.messages.create({
        accountId: Number(provider.accountId),
        conversationId: conversation,
        data: {
          content: `${i18next.t('cw.message.numbernotinwhatsapp')}`,
          message_type: 'outgoing',
          private: true,
        },
      });

      return;
    }

    await client.messages.create({
      accountId: Number(provider.accountId),
      conversationId: conversation,
      data: {
        content: i18next.t('cw.message.notsent', {
          error: error ? `_${error.toString()}_` : '',
        }),
        message_type: 'outgoing',
        private: true,
      },
    });
  }

  public async receiveWebhook(
    instance: InstanceDto,
    body: any,
    authenticatedAdmission?: ChatwootOutboundWebhookHeaders,
  ) {
    let outboundEnqueueAttempted = false;
    try {
      const outboundConfig = this.configService.get<Chatwoot>('CHATWOOT');
      const candidateChatId = chatwootOutboundDestination(body?.conversation);
      const deliverableOutgoing = isDeliverableChatwootOutgoing(body, candidateChatId);
      // Fast-ack Chatwoot echoes that must not be re-sent to WhatsApp. Doing heavy
      // work here races Chatwoot's webhook read timeout and can falsely fail inbound.
      if (body?.event === 'message_created' && !deliverableOutgoing) {
        const isTemplate = body?.message_type === 'template' || body?.message_type === 3 || body?.message_type === '3';
        const alreadyBridged = typeof body?.source_id === 'string' && body.source_id.startsWith('WAID:');
        if ((!isChatwootOutgoingMessageType(body?.message_type) && !isTemplate) || alreadyBridged) {
          return { message: 'ignored' };
        }
      }
      const asyncDeliverable = outboundConfig.OUTBOUND_ASYNC_ENABLED && deliverableOutgoing;
      outboundEnqueueAttempted = asyncDeliverable;
      if (asyncDeliverable && !authenticatedAdmission) {
        throw Object.assign(new Error('Authenticated Chatwoot webhook admission is required'), {
          name: 'ChatwootWebhookAuthenticationError',
          status: 401,
        });
      }
      const authenticatedContext = asyncDeliverable
        ? await this.authenticatedClientCw(instance, authenticatedAdmission)
        : null;
      if (authenticatedContext) Object.assign(instance, authenticatedContext.instance);
      const context = authenticatedContext ?? (asyncDeliverable ? null : await this.clientCw(instance));

      if (!context) {
        if (asyncDeliverable) {
          outboundEnqueueAttempted = true;
          throw Object.assign(new Error('Chatwoot outbound local provider binding is unavailable'), {
            name: 'ChatwootOutboundLocalBindingUnavailable',
            status: 503,
          });
        }
        this.logger.warn('client not found');
        return null;
      }
      const { provider } = context;

      if (
        provider.reopenConversation === false &&
        body.event === 'conversation_status_changed' &&
        body.status === 'resolved' &&
        body.meta?.sender?.identifier
      ) {
        const keyToDelete = `${instance.instanceName}:createConversation-${body.meta.sender.identifier}`;
        this.cache.delete(keyToDelete);
      }

      if (isChatwootNativeMuteProbe(body)) {
        const waInstance = this.waMonitor.waInstances[instance.instanceName];
        if (!waInstance) {
          throw new BadRequestException('WhatsApp instance unavailable for native mute');
        }
        const chatId = resolveNativeChatProbeId(body, candidateChatId);
        if (!chatId || chatId === '123456') {
          throw new BadRequestException('Chat id missing for native mute');
        }
        await this.trySendNativeMute(waInstance, chatId, body);
        return { message: body.muted ? 'muted' : 'unmuted' };
      }

      if (isChatwootNativePinProbe(body)) {
        const waInstance = this.waMonitor.waInstances[instance.instanceName];
        if (!waInstance) {
          throw new BadRequestException('WhatsApp instance unavailable for native pin');
        }
        const chatId = resolveNativeChatProbeId(body, candidateChatId);
        if (!chatId || chatId === '123456') {
          throw new BadRequestException('Chat id missing for native pin');
        }
        await this.trySendNativePin(waInstance, chatId, body);
        return { message: body.pinned ? 'pinned' : 'unpinned' };
      }

      if (isChatwootNativeArchiveProbe(body)) {
        const waInstance = this.waMonitor.waInstances[instance.instanceName];
        if (!waInstance) {
          throw new BadRequestException('WhatsApp instance unavailable for native archive');
        }
        const chatId = resolveNativeChatProbeId(body, candidateChatId);
        if (!chatId || chatId === '123456') {
          throw new BadRequestException('Chat id missing for native archive');
        }
        await this.trySendNativeArchive(waInstance, chatId, body, instance);
        return { message: body.archived ? 'archived' : 'unarchived' };
      }

      if (
        !body?.conversation ||
        body.private ||
        (body.event === 'message_updated' &&
          !isChatwootMessageDeletion(body) &&
          !isChatwootMessageEdit(body) &&
          !isAgentReactionWebhook(body))
      ) {
        return { message: 'bot' };
      }

      const waInstance = this.waMonitor.waInstances[instance.instanceName];

      const exactAsyncStoredBinding =
        !asyncDeliverable ||
        (Boolean(authenticatedAdmission?.routeInstanceId) &&
          authenticatedAdmission?.routeInstanceId === provider.instanceId &&
          authenticatedAdmission?.routeProviderId === provider.id);
      if ((!waInstance && !asyncDeliverable) || !exactAsyncStoredBinding) {
        if (asyncDeliverable) {
          outboundEnqueueAttempted = true;
          throw Object.assign(new Error('Chatwoot outbound local socket binding is unavailable'), {
            name: 'ChatwootOutboundLocalBindingUnavailable',
            status: 503,
          });
        }
        if (
          !outboundConfig.OUTBOUND_ASYNC_ENABLED &&
          isDeliverableChatwootOutgoing(body, candidateChatId) &&
          body.conversation?.id
        ) {
          await this.onSendMessageError(instance, body.conversation.id, body.id, 'Instance not found');
        }
        return { message: 'bot' };
      }

      instance.instanceId = asyncDeliverable ? authenticatedAdmission.routeInstanceId : waInstance.instanceId;

      if (isAgentReactionWebhook(body)) {
        if (!waInstance) {
          throw new BadRequestException('WhatsApp instance unavailable for native reaction');
        }
        return this.sendWhatsappReactionFromChatwoot(instance, waInstance, body);
      }

      if (isChatwootMessageDeletion(body)) {
        const retained = await this.outboundStore.retainedOperations(instance.instanceId, Number(body.id));
        if (retained.length > 0) {
          const candidateDeletionChatId = chatwootOutboundDestination(body.conversation);
          const exactOrigin = retained.every(
            (operation) =>
              Number(body.account?.id) === operation.payload.origin.accountId &&
              Number(body.inbox?.id) === operation.payload.origin.inboxId &&
              Number(body.conversation?.id) === operation.payload.origin.conversationId &&
              Number(body.id) === operation.payload.origin.messageId &&
              candidateDeletionChatId === operation.payload.chatId,
          );
          if (!exactOrigin) throw this.outboundBindingMismatch();
          const deletionController = new AbortController();
          const deletionTimer = setTimeout(() => deletionController.abort(), 20_000);
          let deletionContext;
          try {
            deletionContext = await this.currentOutboundContext(retained[0], deletionController.signal, true);
          } finally {
            clearTimeout(deletionTimer);
          }
          if (!deletionContext) throw this.outboundBindingMismatch();
          await this.outboundStore.requestDeletion(retained[0]);
          this.outboundQueue.wake();

          const neverSent = retained.every((operation) => Number(operation.sendAttempts || 0) === 0);
          const mapped = await this.prismaRepository.message.findFirst({
            where: {
              chatwootMessageId: body.id,
              instanceId: instance.instanceId,
            },
          });

          // Never reached WA — queue cancel is enough for native-first success.
          if (neverSent && !mapped) {
            return { message: 'deleted' };
          }

          if (!waInstance?.client?.sendMessage) {
            throw new BadRequestException('WhatsApp instance unavailable for native delete');
          }
          if (!mapped) {
            throw new BadRequestException('WhatsApp message mapping missing for native delete');
          }

          const retainedKey = mapped.key as WAMessageKey;
          if (
            mapped.chatwootInboxId !== Number(body.inbox?.id) ||
            mapped.chatwootConversationId !== Number(body.conversation?.id) ||
            !retainedKey?.remoteJid ||
            !this.outboundRemoteJidMatches(candidateDeletionChatId, retainedKey.remoteJid)
          ) {
            throw this.outboundBindingMismatch();
          }

          await waInstance.client.sendMessage(retainedKey.remoteJid, { delete: retainedKey });
          await this.prismaRepository.message.deleteMany({
            where: {
              instanceId: instance.instanceId,
              chatwootMessageId: body.id,
            },
          });
          return { message: 'deleted' };
        }
        const liveProvider = await this.prismaRepository.chatwoot.findUnique({
          where: { instanceId: instance.instanceId },
        });
        const deletionRoute = liveProvider
          ? this.buildEvoRouteBinding(instance, liveProvider, Number(body.inbox?.id))
          : null;
        if (!liveProvider?.enabled || !deletionRoute) throw this.outboundBindingMismatch();
        const deletionOrigin: ChatwootOutboundOrigin = {
          providerId: liveProvider.id,
          baseUrl: this.normalizeChatwootBaseUrl(liveProvider.url),
          accountId: Number(body.account?.id),
          inboxId: Number(body.inbox?.id),
          conversationId: Number(body.conversation?.id),
          messageId: Number(body.id),
          ...chatwootOutboundContactIdentity(body),
          inboxName: liveProvider.nameInbox,
          snapshotFingerprint: String(body.outbound_snapshot?.fingerprint || ''),
          routeBinding: deletionRoute,
        };
        const syntheticDeletion: StoredChatwootOutboundOperation = {
          id: 'deletion-validation',
          operationKey: 'deletion-validation',
          messageSetHash: 'deletion-validation',
          instanceId: instance.instanceId,
          chatwootMessageId: deletionOrigin.messageId,
          chatwootInboxId: deletionOrigin.inboxId,
          chatwootConversationId: deletionOrigin.conversationId,
          partIdentity: 'deletion-validation',
          partIndex: 0,
          partCount: 1,
          plannedWhatsappMessageId: 'deletion-validation',
          laneKey: 'deletion-validation',
          laneSequence: 0n,
          state: 'delete_pending',
          payload: { chatId: chatwootOutboundDestination(body.conversation), text: null, origin: deletionOrigin },
          preparationAttempts: 0,
          sendAttempts: 0,
          transportOutcomeUnresolved: false,
          callbackAttempts: 0,
          claimGeneration: 0,
        };
        const deletionController = new AbortController();
        const deletionTimer = setTimeout(() => deletionController.abort(), 20_000);
        let deletionContext;
        try {
          deletionContext = await this.currentOutboundContext(syntheticDeletion, deletionController.signal, true);
        } finally {
          clearTimeout(deletionTimer);
        }
        if (!deletionContext) throw this.outboundBindingMismatch();
        if (!waInstance?.client?.sendMessage) {
          throw new BadRequestException('WhatsApp instance unavailable for native delete');
        }

        const message = await this.prismaRepository.message.findFirst({
          where: {
            chatwootMessageId: body.id,
            instanceId: instance.instanceId,
          },
        });

        if (!message) {
          throw new BadRequestException('WhatsApp message mapping missing for native delete');
        }

        const key = message.key as WAMessageKey;
        if (
          message.chatwootInboxId !== deletionOrigin.inboxId ||
          message.chatwootConversationId !== deletionOrigin.conversationId ||
          !key?.remoteJid ||
          !this.outboundRemoteJidMatches(syntheticDeletion.payload.chatId, key.remoteJid)
        )
          throw this.outboundBindingMismatch();

        await waInstance.client.sendMessage(key.remoteJid, { delete: key });

        await this.prismaRepository.message.deleteMany({
          where: {
            instanceId: instance.instanceId,
            chatwootMessageId: body.id,
          },
        });

        return { message: 'deleted' };
      }

      if (isChatwootMessageEdit(body)) {
        if (!waInstance) {
          throw new BadRequestException('WhatsApp instance unavailable for native edit');
        }
        const chatIdForEdit = candidateChatId;
        const edited = await this.trySendNativeEdit(waInstance, chatIdForEdit, body, instance);
        if (edited?.edit_restriction === 'whatsapp') return { message: 'edit_rejected', ...edited };
        if (!edited) {
          throw new BadRequestException('Native WhatsApp edit failed');
        }
        return { message: 'edited', key: edited.key };
      }

      const chatId = candidateChatId;
      // Chatwoot to Whatsapp
      const mentionedJids = extractWhatsappMentionJids(body);
      const messageReceivedRaw = body.content
        ? body.content
            .replaceAll(/(?<!\*)\*((?!\s)([^\n*]+?)(?<!\s))\*(?!\*)/g, '_$1_') // Substitui * por _
            .replaceAll(/\*{2}((?!\s)([^\n*]+?)(?<!\s))\*{2}/g, '*$1*') // Substitui ** por *
            .replaceAll(/~{2}((?!\s)([^\n*]+?)(?<!\s))~{2}/g, '~$1~') // Substitui ~~ por ~
            .replaceAll(/(?<!`)`((?!\s)([^`*]+?)(?<!\s))`(?!`)/g, '```$1```') // Substitui ` por ```
        : body.content;
      const messageReceived = stripWhatsappMentionMarkdown(messageReceivedRaw);

      const senderName = body?.sender?.available_name || body?.sender?.name;
      const expectedRoute = this.buildEvoRouteBinding(instance, provider, body.inbox?.id);
      const autoReplyBinding = validateChatwootAutoReplyBinding(body, expectedRoute);

      if (autoReplyBinding.valid === false) {
        this.logger.error(
          JSON.stringify({
            event: 'chatwoot_auto_reply_route_rejected',
            reason: autoReplyBinding.reason,
            instanceName: instance.instanceName,
            inboxId: body.inbox?.id,
            messageId: body.id,
            conversationId: body.conversation?.id,
          }),
        );
        if (asyncDeliverable) {
          const error = this.outboundBindingMismatch();
          (error as any).status = 409;
          throw error;
        }
        if (deliverableOutgoing && body.conversation?.id) {
          await this.onSendMessageError(instance, body.conversation.id, body.id, autoReplyBinding.reason);
        }
        return { message: 'bot' };
      }

      const formatOutboundText = () => {
        if (senderName === null || senderName === undefined) return messageReceived;
        const formattedDelimiter = provider.signDelimiter ? provider.signDelimiter.replace(/\\n/g, '\n') : '\n';
        const textToConcat = provider.signMsg ? [`*${senderName}:*`] : [];
        if (messageReceived) textToConcat.push(messageReceived);
        return textToConcat.length > 0 ? textToConcat.join(formattedDelimiter) : null;
      };

      let retainedMessage = false;
      if (deliverableOutgoing) {
        outboundEnqueueAttempted = true;
        retainedMessage = await this.outboundStore.hasRetainedMessage(instance.instanceId, Number(body.id));
        if (!retainedMessage && !outboundConfig.OUTBOUND_ASYNC_ENABLED) outboundEnqueueAttempted = false;
      }
      if (
        deliverableOutgoing &&
        body?.content_attributes?.forwarded &&
        shouldAttemptNativeForward(body.content_attributes.forwarded_from || {})
      ) {
        outboundEnqueueAttempted = true;
        if (!outboundConfig.OUTBOUND_ASYNC_ENABLED) {
          const error = new Error('Native forwarding requires durable asynchronous delivery');
          error.name = 'NativeForwardRequiresAsyncDelivery';
          (error as any).status = 503;
          throw error;
        }
        if (outboundConfig.OUTBOUND_ASYNC_DRAIN_ONLY) {
          const error = new Error('Chatwoot outbound async ingress is paused for drain');
          error.name = 'ChatwootOutboundDrainOnly';
          (error as any).status = 503;
          throw error;
        }
        const nativeForward = await this.resolveNativeForwardSource(waInstance, body, instance);
        if (nativeForward) {
          if (!expectedRoute || Number(provider.accountId) !== Number(body.account?.id)) {
            throw this.outboundBindingMismatch();
          }
          return await this.enqueueChatwootOutbound(
            instance,
            provider,
            expectedRoute,
            body,
            chatId,
            formatOutboundText(),
            authenticatedAdmission,
            nativeForward,
          );
        }
      }
      if (deliverableOutgoing && retainedMessage) {
        if (!expectedRoute || Number(provider.accountId) !== Number(body.account?.id)) {
          throw this.outboundBindingMismatch();
        }
        const retainedResult = await this.enqueueChatwootOutbound(
          instance,
          provider,
          expectedRoute,
          body,
          chatId,
          formatOutboundText(),
          authenticatedAdmission ?? {
            deliveryId: `retained:${instance.instanceId}:${Number(body.id)}`,
            timestampSeconds: Math.floor(Date.now() / 1_000),
            receivedAt: new Date(),
            routeInstanceId: instance.instanceId,
          },
        );
        return { ...retainedResult, retained: true };
      }

      if (deliverableOutgoing && outboundConfig.OUTBOUND_ASYNC_ENABLED) {
        outboundEnqueueAttempted = true;
        if (outboundConfig.OUTBOUND_ASYNC_DRAIN_ONLY) {
          const error = new Error('Chatwoot outbound async ingress is paused for drain');
          error.name = 'ChatwootOutboundDrainOnly';
          (error as any).status = 503;
          throw error;
        }
        if (!expectedRoute || Number(provider.accountId) !== Number(body.account?.id)) {
          const error = new Error('Chatwoot outbound origin or route binding is unavailable');
          error.name = 'OutboundBindingMismatch';
          throw error;
        }
        return await this.enqueueChatwootOutbound(
          instance,
          provider,
          expectedRoute,
          body,
          chatId,
          formatOutboundText(),
          authenticatedAdmission,
        );
      }

      const cwBotContact = this.configService.get<Chatwoot>('CHATWOOT').BOT_CONTACT;

      if (chatId === '123456' && body.message_type === 'outgoing') {
        const command = messageReceived.replace('/', '');

        if (cwBotContact && (command.includes('init') || command.includes('iniciar'))) {
          const state = waInstance?.connectionStatus?.state;

          if (state !== 'open') {
            const number = command.split(':')[1];
            await waInstance.connectToWhatsapp(number);
          } else {
            await this.createBotMessage(
              instance,
              i18next.t('cw.inbox.alreadyConnected', {
                inboxName: body.inbox.name,
              }),
              'incoming',
            );
          }
        }

        if (command === 'clearcache') {
          await waInstance.clearCacheChatwoot();
          await this.createBotMessage(
            instance,
            i18next.t('cw.inbox.clearCache', {
              inboxName: body.inbox.name,
            }),
            'incoming',
          );
        }

        if (command === 'status') {
          const state = waInstance?.connectionStatus?.state;

          if (!state) {
            await this.createBotMessage(
              instance,
              i18next.t('cw.inbox.notFound', {
                inboxName: body.inbox.name,
              }),
              'incoming',
            );
          }

          if (state) {
            await this.createBotMessage(
              instance,
              i18next.t('cw.inbox.status', {
                inboxName: body.inbox.name,
                state: state,
              }),
              'incoming',
            );
          }
        }

        if (cwBotContact && (command === 'disconnect' || command === 'desconectar')) {
          const msgLogout = i18next.t('cw.inbox.disconnect', {
            inboxName: body.inbox.name,
          });

          await this.createBotMessage(instance, msgLogout, 'incoming');

          await waInstance?.client?.logout('Log out instance: ' + instance.instanceName);
          await waInstance?.client?.ws?.close();
        }
      }

      if (deliverableOutgoing) {
        let formatText: string;
        if (senderName === null || senderName === undefined) {
          formatText = messageReceived;
        } else {
          const formattedDelimiter = provider.signDelimiter ? provider.signDelimiter.replace(/\\n/g, '\n') : '\n';
          const textToConcat = provider.signMsg ? [`*${senderName}:*`] : [];
          textToConcat.push(messageReceived);

          formatText = textToConcat.join(formattedDelimiter);
        }

        for (const message of body.conversation.messages) {
          if (message.attachments && message.attachments.length > 0) {
            for (const attachment of message.attachments) {
              if (!messageReceived) {
                formatText = null;
              }

              const options: Options = {
                quoted: await this.getQuotedMessage(body, instance),
                mentioned: mentionedJids.length ? mentionedJids : undefined,
              };

              let messageSent: any;
              try {
                messageSent = await this.sendAttachment(waInstance, chatId, attachment.data_url, formatText, options);
                if (!messageSent) {
                  throw new Error('Attachment not sent');
                }
              } catch (error) {
                if (body.conversation?.id) {
                  await this.onSendMessageError(instance, body.conversation.id, body.id, error);
                }
                throw error;
              }

              await this.updateChatwootMessageId(
                {
                  ...messageSent,
                },
                {
                  messageId: body.id,
                  inboxId: body.inbox?.id,
                  conversationId: body.conversation?.id,
                  contactInboxSourceId: body.conversation?.contact_inbox?.source_id,
                },
                instance,
              );
            }
          } else {
            const data: SendTextDto = {
              number: chatId,
              text: formatText,
              delay: Math.floor(Math.random() * (2000 - 500 + 1)) + 500,
              quoted: await this.getQuotedMessage(body, instance),
              mentioned: mentionedJids.length ? mentionedJids : undefined,
            };

            sendTelemetry('/message/sendText');

            let messageSent: any;
            try {
              messageSent = await waInstance?.textMessage(data, true, buildChatwootOutboundProvenance(body));
              if (!messageSent) {
                throw new Error('Message not sent');
              }

              if (Long.isLong(messageSent?.messageTimestamp)) {
                messageSent.messageTimestamp = messageSent.messageTimestamp?.toNumber();
              }

              await this.updateChatwootMessageId(
                {
                  ...messageSent,
                },
                {
                  messageId: body.id,
                  inboxId: body.inbox?.id,
                  conversationId: body.conversation?.id,
                  contactInboxSourceId: body.conversation?.contact_inbox?.source_id,
                },
                instance,
              );
            } catch (error) {
              if (!messageSent && body.conversation?.id) {
                await this.onSendMessageError(instance, body.conversation.id, body.id, error);
              }
              throw error;
            }
          }
        }

        const chatwootRead = this.configService.get<Chatwoot>('CHATWOOT').MESSAGE_READ;
        if (chatwootRead) {
          const lastMessage = await this.prismaRepository.message.findFirst({
            where: {
              key: {
                path: ['fromMe'],
                equals: false,
              },
              instanceId: instance.instanceId,
            },
          });
          if (lastMessage && !lastMessage.chatwootIsRead) {
            const key = lastMessage.key as WAMessageKey;

            waInstance?.markMessageAsRead({
              readMessages: [
                {
                  id: key.id,
                  fromMe: key.fromMe,
                  remoteJid: key.remoteJid,
                },
              ],
            });
            const updateMessage = {
              chatwootMessageId: lastMessage.chatwootMessageId,
              chatwootConversationId: lastMessage.chatwootConversationId,
              chatwootInboxId: lastMessage.chatwootInboxId,
              chatwootContactInboxSourceId: lastMessage.chatwootContactInboxSourceId,
              chatwootIsRead: true,
            };

            await this.prismaRepository.message.updateMany({
              where: {
                instanceId: instance.instanceId,
                key: {
                  path: ['id'],
                  equals: key.id,
                },
              },
              data: updateMessage,
            });
          }
        }
      }

      if (body.message_type === 'template' && body.event === 'message_created') {
        const data: SendTextDto = {
          number: chatId,
          text: body.content.replace(/\\\r\n|\\\n|\n/g, '\n'),
          delay: Math.floor(Math.random() * (2000 - 500 + 1)) + 500,
        };

        sendTelemetry('/message/sendText');

        await waInstance?.textMessage(data);
      }

      return { message: 'bot' };
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'chatwoot_webhook_error',
          errorClass: error?.name || 'Error',
          failClosed: outboundEnqueueAttempted,
        }),
      );

      if (outboundEnqueueAttempted) throw error;
      // Native-first edit probe: Chatwoot only applies text after a successful response.
      if (
        isChatwootMessageEdit(body) ||
        isChatwootMessageDeletion(body) ||
        isChatwootNativeMuteProbe(body) ||
        isChatwootNativePinProbe(body) ||
        isChatwootNativeArchiveProbe(body) ||
        isAgentReactionWebhook(body)
      )
        throw error;

      return { message: 'bot' };
    }
  }

  /**
   * Map inbound WA messages onto Chatwoot IDs so later native forward / reply /
   * delete can resolve the original Baileys payload (contacts, media, etc.).
   */
  private async bindInboundChatwootMessageId(
    sourceId: string | undefined,
    chatwootMessage: { id?: number } | null | undefined,
    instance: InstanceDto,
    conversationId: number,
  ): Promise<void> {
    const whatsappMessageId = whatsappIdFromSourceId(sourceId);
    const chatwootMessageId = Number(chatwootMessage?.id);
    if (!whatsappMessageId || !Number.isSafeInteger(chatwootMessageId) || chatwootMessageId <= 0) {
      return;
    }

    try {
      await this.persistLocalChatwootMessageBinding(
        whatsappMessageId,
        {
          messageId: chatwootMessageId,
          conversationId,
        },
        instance,
      );
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'chatwoot_inbound_message_bind_failed',
          chatwootMessageId,
          whatsappMessageId,
          errorClass: error?.name || 'Error',
          errorMessage: String(error?.message || error).slice(0, 200),
        }),
      );
    }
  }

  private async resolveStoredForwardMessage(
    instance: InstanceDto,
    sourceMessageId: number,
    sourceId: unknown,
  ): Promise<MessageModel | null> {
    const byChatwootId = await this.prismaRepository.message.findFirst({
      where: {
        chatwootMessageId: sourceMessageId,
        instanceId: instance.instanceId,
      },
    });
    if (byChatwootId?.key && byChatwootId?.message) {
      return byChatwootId;
    }

    const whatsappMessageId = whatsappIdFromSourceId(sourceId);
    if (!whatsappMessageId) return byChatwootId || null;

    const byKey = await this.getMessageByKeyId(instance, whatsappMessageId);
    if (byKey?.key && byKey?.message) {
      // Heal the mapping for subsequent native ops (edit/delete/forward).
      try {
        await this.persistLocalChatwootMessageBinding(whatsappMessageId, { messageId: sourceMessageId }, instance);
      } catch {
        // Best-effort heal — forward can still proceed with the key lookup.
      }
      return byKey;
    }

    return byChatwootId || null;
  }

  private async updateChatwootMessageId(
    message: MessageModel,
    chatwootMessageIds: ChatwootMessage,
    instance: InstanceDto,
  ) {
    const key = message.key as WAMessageKey;

    if (!chatwootMessageIds.messageId || !key?.id) {
      return;
    }

    const result = await this.persistLocalChatwootMessageBinding(key.id, chatwootMessageIds, instance);

    this.logger.verbose(`Update result: ${result} rows affected`);

    if (this.isImportHistoryAvailable()) {
      try {
        await chatwootImport.updateMessageSourceID(chatwootMessageIds.messageId, key.id);
      } catch (error) {
        this.logger.error(
          JSON.stringify({ event: 'chatwoot_source_id_update_error', errorClass: error?.name || 'Error' }),
        );
      }
    }
  }

  private async persistLocalChatwootMessageBinding(
    whatsappMessageId: string,
    chatwootMessageIds: ChatwootMessage,
    instance: InstanceDto,
    acknowledgedParts?: ChatwootProviderDeliveryPart[],
  ): Promise<number> {
    const persist = async (binding: ChatwootMessage): Promise<number> =>
      this.prismaRepository.$transaction(
        (transaction) => transaction.$executeRaw`
        UPDATE "Message"
        SET "chatwootMessageId" = ${chatwootMessageIds.messageId},
            "chatwootConversationId" = ${binding.conversationId},
            "chatwootInboxId" = ${binding.inboxId},
            "chatwootContactInboxSourceId" = ${binding.contactInboxSourceId},
            "chatwootIsRead" = ${chatwootMessageIds.isRead || false}
        WHERE "instanceId" = ${instance.instanceId} AND "key"->>'id' = ${whatsappMessageId}
      `,
        { maxWait: 2000, timeout: 5000 },
      );
    if (!this.configService.get<Chatwoot>('CHATWOOT').PROVIDER_CONVERSATION_BINDINGS)
      return persist(chatwootMessageIds);
    const capability = await postgresClient
      .getChatwootConnection()
      .query(
        "SELECT to_regclass('public.provider_conversation_routes') AS routes, to_regprocedure('public.provider_message_conversation_route(integer,integer,integer)') AS resolver",
      );
    // Deploy this EFO lock-order correction before the atomic CW migration.
    // No route/deletion can exist while both migration objects are absent.
    if (!capability.rows[0]?.routes && !capability.rows[0]?.resolver) return persist(chatwootMessageIds);
    if (!capability.rows[0]?.routes || !capability.rows[0]?.resolver)
      throw new Error('Incomplete canonical routing migration');
    const context = await this.clientCw(instance);
    const inbox = await this.getInbox(instance);
    if (!context || !inbox) throw new Error('Canonical mapping provider context unavailable');
    return withCanonicalChatwootMessageBinding(
      postgresClient.getChatwootConnection(),
      {
        accountId: Number(context.provider.accountId),
        inboxId: Number(inbox.id),
        messageId: Number(chatwootMessageIds.messageId),
        whatsappMessageId,
        claimedConversationId: chatwootMessageIds.conversationId,
        acknowledgedParts,
      },
      persist,
    );
  }

  private async getMessageByKeyId(instance: InstanceDto, keyId: string): Promise<MessageModel> {
    // Use raw SQL query to avoid JSON path issues with Prisma
    const messages = await this.prismaRepository.$queryRaw`
      SELECT * FROM "Message" 
      WHERE "instanceId" = ${instance.instanceId} 
      AND "key"->>'id' = ${keyId}
      LIMIT 1
    `;

    return (messages as MessageModel[])[0] || null;
  }

  private async getReplyToIds(msg: any, instance: InstanceDto): Promise<Record<string, string | number>> {
    let inReplyTo = null;
    let inReplyToExternalId = null;
    let quoteText = null;

    if (msg) {
      const stanzaId = extractWhatsappReplyStanzaId(msg);
      // Chatwoot Evolution messages use source_id `WAID:<stanzaId>`.
      inReplyToExternalId = toChatwootWhatsappSourceId(stanzaId);
      if (stanzaId) {
        const message = await this.getMessageByKeyId(instance, stanzaId);
        if (message?.chatwootMessageId) {
          inReplyTo = message.chatwootMessageId;
        }
        quoteText = whatsappReplyQuoteSnapshotText(msg, message?.message);
      }
    }

    return compactReplyToIds({
      in_reply_to: inReplyTo,
      in_reply_to_external_id: inReplyToExternalId,
      quote_text: quoteText,
    });
  }

  private async getQuotedMessage(msg: any, instance: InstanceDto): Promise<Quoted> {
    const references = chatwootReplyReferences(msg?.content_attributes);
    let message: MessageModel | null = null;
    if (references.chatwootMessageId) {
      message = await this.prismaRepository.message.findFirst({
        where: {
          chatwootMessageId: references.chatwootMessageId,
          instanceId: instance.instanceId,
        },
      });

      const quoted = this.quotedMessage(message, references.quoteText);
      if (quoted) return quoted;
    }

    if (references.whatsappMessageId) {
      message = await this.getMessageByKeyId(instance, references.whatsappMessageId);
      const quoted = this.quotedMessage(message, references.quoteText);
      if (quoted) return quoted;
    }

    if (references.chatwootMessageId || references.whatsappMessageId) {
      throw new BadRequestException('Quoted WhatsApp message not found');
    }

    return null;
  }

  private quotedMessage(message: MessageModel | null, quoteText?: string): Quoted {
    const key = message?.key as WAMessageKey;
    const messageContent = message?.message as WAMessageContent;

    if (!messageContent || !key?.id) return null;

    return { key, message: whatsappQuotedMessageContent(messageContent, quoteText) as WAMessageContent };
  }

  /**
   * Native WhatsApp forward (Baileys `{ forward }`) when Chatwoot marks the
   * outgoing message as forwarded and the source WA message is in this instance.
   * Returns null to fall back to content re-send.
   */
  private async resolveNativeForwardSource(
    waInstance: any,
    body: any,
    instance: InstanceDto,
  ): Promise<{ sourceChatwootMessageId: number; sourceWhatsappMessageId: string } | null> {
    const attrs = body?.content_attributes;
    if (!attrs?.forwarded) return null;

    const from = attrs.forwarded_from || {};
    const sourceMessageId = Number(from.message_id);
    if (!Number.isSafeInteger(sourceMessageId) || sourceMessageId <= 0) return null;

    if (!shouldAttemptNativeForward(from)) return null;

    const stored = await this.resolveStoredForwardMessage(instance, sourceMessageId, from.source_id);

    const key = stored?.key as WAMessageKey | undefined;
    const messageContent = stored?.message as WAMessageContent | undefined;
    if (!key?.id || !messageContent || !waInstance?.nativeForwardMessage) {
      this.logger.warn(
        JSON.stringify({
          event: 'chatwoot_native_forward_source_missing',
          sourceMessageId,
          sourceId: typeof from.source_id === 'string' ? from.source_id.slice(0, 80) : null,
        }),
      );
      return null;
    }

    return { sourceChatwootMessageId: sourceMessageId, sourceWhatsappMessageId: key.id };
  }

  /**
   * Native WhatsApp mute/unmute (Baileys chatModify) for Chatwoot mute probe.
   * Works for 1:1 and @g.us groups.
   */
  private async trySendNativeMute(waInstance: any, chatId: string, body: any): Promise<void> {
    const muted = body?.muted === true;
    const muteUntilMs =
      typeof body?.mute_until_ms === 'number' && body.mute_until_ms > 0
        ? body.mute_until_ms
        : muted
          ? Date.now() + 100 * 365 * 24 * 60 * 60 * 1000
          : null;

    if (typeof waInstance?.muteChat === 'function') {
      await waInstance.muteChat({ number: chatId, mute: muted ? muteUntilMs : null });
    } else {
      throw new BadRequestException('WhatsApp mute API unavailable');
    }

    this.logger.verbose(
      JSON.stringify({
        event: 'chatwoot_native_mute_sent',
        chatwootConversationId: body?.id,
        targetChatId: chatId,
        muted,
      }),
    );
  }

  /**
   * Native WhatsApp pin/unpin (Baileys chatModify { pin }) for Chatwoot pin probe.
   */
  private async trySendNativePin(waInstance: any, chatId: string, body: any): Promise<void> {
    const pinned = body?.pinned === true;
    if (typeof waInstance?.pinChat === 'function') {
      await waInstance.pinChat({ number: chatId, pin: pinned });
    } else {
      throw new BadRequestException('WhatsApp pin API unavailable');
    }

    this.logger.verbose(
      JSON.stringify({
        event: 'chatwoot_native_pin_sent',
        chatwootConversationId: body?.id,
        targetChatId: chatId,
        pinned,
      }),
    );
  }

  /**
   * Native WhatsApp archive/unarchive (Baileys chatModify { archive }) for Chatwoot archive probe.
   * Prefers a real last message keyed to this Chatwoot conversation (display_id in body.id)
   * so PN/@lid mismatches and empty JID lookups do not fail closed incorrectly.
   */
  private async trySendNativeArchive(waInstance: any, chatId: string, body: any, instance: InstanceDto): Promise<void> {
    const archived = body?.archived === true;
    if (typeof waInstance?.archiveChat !== 'function') {
      throw new BadRequestException('WhatsApp archive API unavailable');
    }

    const conversationId = Number(body?.id);
    let lastMessage: any = null;
    if (Number.isFinite(conversationId) && conversationId > 0) {
      lastMessage = await this.prismaRepository.message.findFirst({
        where: {
          instanceId: instance.instanceId,
          chatwootConversationId: conversationId,
        },
        orderBy: { messageTimestamp: 'desc' },
      });
    }

    const archivePayload: { chat: string; archive: boolean; lastMessage?: any } = {
      chat: chatId,
      archive: archived,
    };
    if (lastMessage?.key) {
      archivePayload.lastMessage = {
        key: lastMessage.key,
        messageTimestamp: Number(lastMessage.messageTimestamp) || Math.floor(Date.now() / 1000),
      };
    }

    await waInstance.archiveChat(archivePayload);

    this.logger.verbose(
      JSON.stringify({
        event: 'chatwoot_native_archive_sent',
        chatwootConversationId: body?.id,
        targetChatId: chatId,
        archived,
        lastMessageRemoteJid: archivePayload.lastMessage?.key?.remoteJid || null,
      }),
    );
  }

  /**
   * Native WhatsApp edit (Baileys `{ edit: key }`) for Chatwoot native_edit_probe.
   * Chatwoot applies local text only after this succeeds.
   */
  private async trySendNativeEdit(
    waInstance: any,
    chatId: string,
    body: any,
    instance: InstanceDto,
  ): Promise<any | null> {
    const text = typeof body?.content === 'string' ? body.content : '';
    if (!text.trim() || !waInstance?.updateMessage) return null;

    const stored = await this.prismaRepository.message.findFirst({
      where: {
        chatwootMessageId: Number(body.id),
        instanceId: instance.instanceId,
      },
    });
    const key = stored?.key as WAMessageKey | undefined;
    if (!key?.id) return null;

    try {
      const messageSent = await waInstance.updateMessage({
        number: chatId,
        key,
        text,
      });
      this.logger.verbose(
        JSON.stringify({
          event: 'chatwoot_native_edit_sent',
          chatwootMessageId: body.id,
          targetChatId: chatId,
        }),
      );
      return messageSent;
    } catch (error) {
      if (Array.isArray(error?.message) && error.message.includes('whatsapp_edit_time_expired')) {
        return { edit_restriction: 'whatsapp', edit_restriction_reason: 'time_expired' };
      }
      if (Array.isArray(error?.message) && error.message.includes('whatsapp_edit_restricted')) {
        return { edit_restriction: 'whatsapp' };
      }
      this.logger.warn(
        JSON.stringify({
          event: 'chatwoot_native_edit_failed',
          chatwootMessageId: body.id,
          errorClass: error?.name || 'Error',
          errorMessage: String(error?.message || error).slice(0, 200),
        }),
      );
      return null;
    }
  }

  private isMediaMessage(message: any) {
    const media = [
      'imageMessage',
      'documentMessage',
      'documentWithCaptionMessage',
      'audioMessage',
      'videoMessage',
      'stickerMessage',
      'viewOnceMessageV2',
    ];

    const messageKeys = Object.keys(message);

    const result = messageKeys.some((key) => media.includes(key));

    return result;
  }

  private isInteractiveButtonMessage(messageType: string, message: any) {
    return messageType === 'interactiveMessage' && message.interactiveMessage?.nativeFlowMessage?.buttons?.length > 0;
  }

  private getAdsMessage(msg: any) {
    interface AdsMessage {
      title: string;
      body: string;
      thumbnailUrl: string;
      sourceUrl: string;
    }

    const adsMessage: AdsMessage | undefined = {
      title: msg.extendedTextMessage?.contextInfo?.externalAdReply?.title || msg.contextInfo?.externalAdReply?.title,
      body: msg.extendedTextMessage?.contextInfo?.externalAdReply?.body || msg.contextInfo?.externalAdReply?.body,
      thumbnailUrl:
        msg.extendedTextMessage?.contextInfo?.externalAdReply?.thumbnailUrl ||
        msg.contextInfo?.externalAdReply?.thumbnailUrl,
      sourceUrl:
        msg.extendedTextMessage?.contextInfo?.externalAdReply?.sourceUrl || msg.contextInfo?.externalAdReply?.sourceUrl,
    };

    return adsMessage;
  }

  private getReactionMessage(msg: any) {
    interface ReactionMessage {
      key: {
        id: string;
        fromMe: boolean;
        remoteJid: string;
        participant?: string;
      };
      text: string;
    }
    const reactionMessage: ReactionMessage | undefined = msg?.reactionMessage;

    return reactionMessage;
  }

  private async applyNativeChatwootMuteFromWhatsapp(
    instance: InstanceDto,
    provider: any,
    body: { id?: string; muteEndTime?: number | null; pinned?: number | null; archived?: boolean },
  ): Promise<void> {
    const remoteJid = body?.id;
    if (!remoteJid) return;

    const muteEndRaw = body?.muteEndTime as any;
    const muteEnd =
      muteEndRaw == null
        ? null
        : typeof muteEndRaw === 'object' && muteEndRaw !== null && typeof muteEndRaw.toNumber === 'function'
          ? Number(muteEndRaw.toNumber())
          : Number(muteEndRaw);
    const hasMuteUpdate = muteEndRaw !== undefined;
    // Baileys emits muteEndTime in unix seconds; some builds use ms. Normalize to ms.
    const muteEndMs = muteEnd == null || !Number.isFinite(muteEnd) ? null : muteEnd < 1e11 ? muteEnd * 1000 : muteEnd;
    const muted = muteEndMs != null && muteEndMs > Date.now();

    const hasPinUpdate = body?.pinned !== undefined;
    const pinned = body?.pinned != null && Number(body.pinned) > 0;

    const hasArchiveUpdate = body?.archived !== undefined;
    const archived = body?.archived === true;

    if (!hasMuteUpdate && !hasPinUpdate && !hasArchiveUpdate) return;

    const stored = await this.prismaRepository.message.findFirst({
      where: {
        instanceId: instance.instanceId,
        key: { path: ['remoteJid'], equals: remoteJid },
        chatwootConversationId: { not: null },
      },
      orderBy: { messageTimestamp: 'desc' },
    });
    const conversationId = stored?.chatwootConversationId;
    if (!conversationId) {
      this.logger.verbose(JSON.stringify({ event: 'chatwoot_chat_update_target_missing', remoteJid }));
      return;
    }

    const accountId = provider.accountId;
    let current: { muted?: boolean; pinned?: boolean; archived?: boolean } | null = null;
    try {
      const raw = await this.privilegedChatwootRead(
        provider,
        `/api/v1/accounts/${accountId}/conversations/${conversationId}`,
      );
      // Show endpoint is flat; list-style wrappers use payload — accept both.
      const rawAny = raw as { payload?: unknown; muted?: boolean; pinned?: boolean; archived?: boolean } | null;
      current = (rawAny?.payload && typeof rawAny.payload === 'object' ? rawAny.payload : rawAny) as typeof current;
    } catch {
      current = null;
    }

    const applyEndpoint = async (action: string) => {
      await this.privilegedChatwootRequest(provider, {
        method: 'POST',
        path: `/api/v1/accounts/${accountId}/conversations/${conversationId}/${action}`,
        data: { skip_native: true },
      });
    };

    try {
      if (hasMuteUpdate && (current == null || Boolean(current?.muted) !== muted)) {
        await applyEndpoint(muted ? 'mute' : 'unmute');
        this.logger.verbose(
          JSON.stringify({
            event: 'chatwoot_native_mute_applied',
            conversationId,
            remoteJid,
            muted,
          }),
        );
      }
      if (hasPinUpdate && (current == null || Boolean(current?.pinned) !== pinned)) {
        await applyEndpoint(pinned ? 'pin' : 'unpin');
        this.logger.verbose(
          JSON.stringify({
            event: 'chatwoot_native_pin_applied',
            conversationId,
            remoteJid,
            pinned,
          }),
        );
      }
      if (hasArchiveUpdate && (current == null || Boolean(current?.archived) !== archived)) {
        await applyEndpoint(archived ? 'archive' : 'unarchive');
        this.logger.verbose(
          JSON.stringify({
            event: 'chatwoot_native_archive_applied',
            conversationId,
            remoteJid,
            archived,
          }),
        );
      }
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'chatwoot_chat_update_apply_failed',
          conversationId,
          remoteJid,
          errorClass: (error as any)?.name || 'Error',
          message: (error as any)?.message,
        }),
      );
    }
  }

  private async applyNativeChatwootReaction(
    instance: InstanceDto,
    conversationId: number,
    body: any,
    reactionMessage: { key: { id: string }; text?: string },
  ): Promise<boolean> {
    const target = await this.getMessageByKeyId(instance, reactionMessage.key.id);
    if (!target?.chatwootMessageId) {
      this.logger.warn(
        JSON.stringify({
          event: 'chatwoot_reaction_target_missing',
          waMessageId: reactionMessage.key.id,
          conversationId,
        }),
      );
      return false;
    }

    const context = await this.clientCw(instance);
    if (!context) return false;
    const { provider } = context;
    const actor = buildWhatsappReactionActor(body);
    const emoji = reactionMessage.text || '';

    try {
      await this.privilegedChatwootRequest(provider, {
        method: 'POST',
        path: `/api/v1/accounts/${provider.accountId}/conversations/${conversationId}/messages/${target.chatwootMessageId}/react`,
        data: {
          emoji,
          ...actor,
          skip_native: true,
        },
      });
      return true;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'chatwoot_reaction_apply_failed',
          conversationId,
          messageId: target.chatwootMessageId,
          errorClass: (error as any)?.name || 'Error',
          message: (error as any)?.message,
        }),
      );
      return false;
    }
  }

  private async sendWhatsappReactionFromChatwoot(
    instance: InstanceDto,
    waInstance: any,
    body: any,
  ): Promise<{ message: string } | { accepted: true }> {
    const reaction = body?.reaction;
    if (!reaction) return { message: 'bot' };

    let localMessage = await this.prismaRepository.message.findFirst({
      where: {
        chatwootMessageId: Number(body.id),
        instanceId: instance.instanceId,
      },
    });

    if (!localMessage) {
      const waId = String(body.source_id || '')
        .replace(/^WAID:/i, '')
        .trim();
      if (waId) {
        localMessage = await this.getMessageByKeyId(instance, waId);
      }
    }

    const key = resolveWhatsappReactionKey({
      storedKey: localMessage?.key as {
        id?: string;
        remoteJid?: string;
        fromMe?: boolean;
        participant?: string;
      } | null,
      sourceId: body.source_id,
      messageType: body.message_type,
      body,
    });

    if (!key?.id || !key?.remoteJid) {
      this.logger.warn(
        JSON.stringify({
          event: 'chatwoot_reaction_outbound_key_missing',
          chatwootMessageId: body.id,
          sourceId: body.source_id,
        }),
      );
      throw new BadRequestException('WhatsApp reaction key unavailable');
    }

    const emoji = reaction.action === 'remove' ? '' : String(reaction.emoji || '');
    await waInstance.reactionMessage({
      key: {
        id: key.id,
        remoteJid: key.remoteJid,
        fromMe: Boolean(key.fromMe),
        participant: key.participant,
      },
      reaction: emoji,
    });
    return { message: 'reacted' };
  }

  private getTypeMessage(msg: any) {
    const types = {
      conversation: msg.conversation,
      imageMessage: msg.imageMessage?.caption,
      videoMessage: msg.videoMessage?.caption,
      extendedTextMessage: msg.extendedTextMessage?.text,
      messageContextInfo: msg.messageContextInfo?.stanzaId,
      stickerMessage: undefined,
      documentMessage: msg.documentMessage?.caption,
      documentWithCaptionMessage: msg.documentWithCaptionMessage?.message?.documentMessage?.caption,
      audioMessage: msg.audioMessage ? (msg.audioMessage.caption ?? '') : undefined,
      contactMessage: msg.contactMessage?.vcard,
      contactsArrayMessage: msg.contactsArrayMessage,
      locationMessage: msg.locationMessage,
      liveLocationMessage: msg.liveLocationMessage,
      listMessage: msg.listMessage,
      listResponseMessage: msg.listResponseMessage,
      viewOnceMessageV2:
        msg?.message?.viewOnceMessageV2?.message?.imageMessage?.url ||
        msg?.message?.viewOnceMessageV2?.message?.videoMessage?.url ||
        msg?.message?.viewOnceMessageV2?.message?.audioMessage?.url,
    };

    return types;
  }

  private getMessageContent(types: any) {
    const typeKey = Object.keys(types).find((key) => types[key] !== undefined);

    let result = typeKey ? types[typeKey] : undefined;

    // Remove externalAdReplyBody| in Chatwoot (Already Have)
    if (result && typeof result === 'string' && result.includes('externalAdReplyBody|')) {
      result = result.split('externalAdReplyBody|').filter(Boolean).join('');
    }

    if (typeKey === 'locationMessage' || typeKey === 'liveLocationMessage') {
      const latitude = result.degreesLatitude;
      const longitude = result.degreesLongitude;

      const locationName = result?.name;
      const locationAddress = result?.address;

      const formattedLocation =
        `*${i18next.t('cw.locationMessage.location')}:*\n\n` +
        `_${i18next.t('cw.locationMessage.latitude')}:_ ${latitude} \n` +
        `_${i18next.t('cw.locationMessage.longitude')}:_ ${longitude} \n` +
        (locationName ? `_${i18next.t('cw.locationMessage.locationName')}:_ ${locationName}\n` : '') +
        (locationAddress ? `_${i18next.t('cw.locationMessage.locationAddress')}:_ ${locationAddress} \n` : '') +
        `_${i18next.t('cw.locationMessage.locationUrl')}:_ ` +
        `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;

      return formattedLocation;
    }

    if (typeKey === 'contactMessage') {
      const vCardData = result.split('\n');
      const contactInfo = {};

      vCardData.forEach((line) => {
        const [key, value] = line.split(':');
        if (key && value) {
          contactInfo[key] = value;
        }
      });

      let formattedContact =
        `*${i18next.t('cw.contactMessage.contact')}:*\n\n` +
        `_${i18next.t('cw.contactMessage.name')}:_ ${contactInfo['FN']}`;

      let numberCount = 1;
      Object.keys(contactInfo).forEach((key) => {
        if (key.startsWith('item') && key.includes('TEL')) {
          const phoneNumber = contactInfo[key];
          formattedContact += `\n_${i18next.t('cw.contactMessage.number')} (${numberCount}):_ ${phoneNumber}`;
          numberCount++;
        } else if (key.includes('TEL')) {
          const phoneNumber = contactInfo[key];
          formattedContact += `\n_${i18next.t('cw.contactMessage.number')} (${numberCount}):_ ${phoneNumber}`;
          numberCount++;
        }
      });

      return formattedContact;
    }

    if (typeKey === 'contactsArrayMessage') {
      const formattedContacts = result.contacts.map((contact) => {
        const vCardData = contact.vcard.split('\n');
        const contactInfo = {};

        vCardData.forEach((line) => {
          const [key, value] = line.split(':');
          if (key && value) {
            contactInfo[key] = value;
          }
        });

        let formattedContact = `*${i18next.t('cw.contactMessage.contact')}:*\n\n_${i18next.t(
          'cw.contactMessage.name',
        )}:_ ${contact.displayName}`;

        let numberCount = 1;
        Object.keys(contactInfo).forEach((key) => {
          if (key.startsWith('item') && key.includes('TEL')) {
            const phoneNumber = contactInfo[key];
            formattedContact += `\n_${i18next.t('cw.contactMessage.number')} (${numberCount}):_ ${phoneNumber}`;
            numberCount++;
          } else if (key.includes('TEL')) {
            const phoneNumber = contactInfo[key];
            formattedContact += `\n_${i18next.t('cw.contactMessage.number')} (${numberCount}):_ ${phoneNumber}`;
            numberCount++;
          }
        });

        return formattedContact;
      });

      const formattedContactsArray = formattedContacts.join('\n\n');

      return formattedContactsArray;
    }

    if (typeKey === 'listMessage') {
      const listTitle = result?.title || 'Unknown';
      const listDescription = result?.description || 'Unknown';
      const listFooter = result?.footerText || 'Unknown';

      let formattedList =
        '*List Menu:*\n\n' +
        '_Title_: ' +
        listTitle +
        '\n' +
        '_Description_: ' +
        listDescription +
        '\n' +
        '_Footer_: ' +
        listFooter;

      if (result.sections && result.sections.length > 0) {
        result.sections.forEach((section, sectionIndex) => {
          formattedList += '\n\n*Section ' + (sectionIndex + 1) + ':* ' + section.title || 'Unknown\n';

          if (section.rows && section.rows.length > 0) {
            section.rows.forEach((row, rowIndex) => {
              formattedList += '\n*Line ' + (rowIndex + 1) + ':*\n';
              formattedList += '_▪️ Title:_ ' + (row.title || 'Unknown') + '\n';
              formattedList += '_▪️ Description:_ ' + (row.description || 'Unknown') + '\n';
              formattedList += '_▪️ ID:_ ' + (row.rowId || 'Unknown') + '\n';
            });
          } else {
            formattedList += '\nNo lines found in this section.\n';
          }
        });
      } else {
        formattedList += '\nNo sections found.\n';
      }

      return formattedList;
    }

    if (typeKey === 'listResponseMessage') {
      const responseTitle = result?.title || 'Unknown';
      const responseDescription = result?.description || 'Unknown';
      const responseRowId = result?.singleSelectReply?.selectedRowId || 'Unknown';

      const formattedResponseList =
        '*List Response:*\n\n' +
        '_Title_: ' +
        responseTitle +
        '\n' +
        '_Description_: ' +
        responseDescription +
        '\n' +
        '_ID_: ' +
        responseRowId;
      return formattedResponseList;
    }

    return result;
  }

  public getConversationMessage(msg: any) {
    const types = this.getTypeMessage(msg);

    const messageContent = this.getMessageContent(types);

    return messageContent;
  }

  public async eventWhatsapp(event: string, instance: InstanceDto, body: any) {
    const deliveryKey = chatwootIngressDeliveryKey({
      event,
      instanceId: instance.instanceId,
      whatsappMessageId: body?.key?.id,
    });
    if (!deliveryKey) return this.processWhatsappEvent(event, instance, body);

    return this.inboundDeliveryFence.run(deliveryKey, async () => {
      const existing = await this.prismaRepository.message.findFirst({
        where: {
          instanceId: instance.instanceId,
          key: { path: ['id'], equals: body.key.id },
          chatwootMessageId: { not: null },
        },
        orderBy: { messageTimestamp: 'desc' },
      });
      if (existing?.chatwootMessageId && existing.chatwootConversationId) {
        return {
          id: existing.chatwootMessageId,
          inbox_id: existing.chatwootInboxId,
          conversation_id: existing.chatwootConversationId,
        };
      }

      return this.processWhatsappEvent(event, instance, body);
    });
  }

  private async processWhatsappEvent(event: string, instance: InstanceDto, body: any) {
    try {
      const waInstance = this.waMonitor.waInstances[instance.instanceName];

      if (!waInstance) {
        this.logger.warn('wa instance not found');
        return null;
      }

      if (
        (event === 'messages.upsert' || event === 'send.message') &&
        (await isChatwootOutboundEcho(body, (whatsappMessageId) =>
          isRetainedChatwootOutboundMessageId(this.prismaRepository, instance.instanceId, whatsappMessageId),
        ))
      ) {
        this.logger.info(
          JSON.stringify({ event: 'chatwoot_outbound_echo_suppressed', instanceId: instance.instanceId }),
        );
        return null;
      }

      const context = await this.clientCw(instance);

      if (!context) {
        this.logger.warn('client not found');
        return null;
      }
      const { client, provider } = context;

      if (event === 'chats.update') {
        await this.applyNativeChatwootMuteFromWhatsapp(instance, provider, body);
        return { message: 'ok' };
      }

      const ignoreJids = Array.isArray(provider.ignoreJids)
        ? provider.ignoreJids.filter((jid): jid is string => typeof jid === 'string')
        : [];
      if (ignoreJids.length > 0) {
        let ignoreGroups = false;
        let ignoreContacts = false;

        if (ignoreJids.includes('@g.us')) {
          ignoreGroups = true;
        }

        if (ignoreJids.includes('@s.whatsapp.net')) {
          ignoreContacts = true;
        }

        if (ignoreGroups && body?.key?.remoteJid.endsWith('@g.us')) {
          this.logger.warn('Ignoring message from group: ' + body?.key?.remoteJid);
          return;
        }

        if (ignoreContacts && body?.key?.remoteJid.endsWith('@s.whatsapp.net')) {
          this.logger.warn('Ignoring message from contact: ' + body?.key?.remoteJid);
          return;
        }

        if (ignoreJids.includes(body?.key?.remoteJid)) {
          this.logger.warn('Ignoring message from jid: ' + body?.key?.remoteJid);
          return;
        }
      }

      if (event === 'messages.upsert' || event === 'send.message') {
        this.logger.info(`[${event}] New message received - Instance: ${JSON.stringify(body, null, 2)}`);
        const clientSent = isChatwootLinkedClientSentEvent(event, body);
        if (body.key.remoteJid === 'status@broadcast') {
          return;
        }

        if (body.message?.ephemeralMessage?.message) {
          body.message = {
            ...body.message?.ephemeralMessage?.message,
          };
        }

        const originalMessage = await this.getConversationMessage(body.message);
        const bodyMessage = originalMessage
          ? originalMessage
              .replaceAll(/\*((?!\s)([^\n*]+?)(?<!\s))\*/g, '**$1**')
              .replaceAll(/_((?!\s)([^\n_]+?)(?<!\s))_/g, '*$1*')
              .replaceAll(/~((?!\s)([^\n~]+?)(?<!\s))~/g, '~~$1~~')
          : originalMessage;

        if (bodyMessage && bodyMessage.includes('/survey/responses/') && bodyMessage.includes('http')) {
          return;
        }

        const quotedId = extractWhatsappReplyStanzaId(body);

        let quotedMsg = null;

        if (quotedId)
          quotedMsg = await this.prismaRepository.message.findFirst({
            where: {
              instanceId: instance.instanceId,
              key: {
                path: ['id'],
                equals: quotedId,
              },
              chatwootMessageId: {
                not: null,
              },
            },
          });

        const isMedia = this.isMediaMessage(body.message);

        const adsMessage = this.getAdsMessage(body);

        const reactionMessage = this.getReactionMessage(body.message);
        const isInteractiveButtonMessage = this.isInteractiveButtonMessage(body.messageType, body.message);

        if (!bodyMessage && !isMedia && !reactionMessage && !isInteractiveButtonMessage) {
          this.logger.warn('no body message found');
          return;
        }

        const getConversation = await this.createConversation(instance, body);

        if (!getConversation) {
          this.logger.warn('conversation not found');
          return;
        }

        const messageType = body.key.fromMe ? 'outgoing' : 'incoming';
        const isGroupMessage = body.key.remoteJid.includes('@g.us');
        let chatwootBodyMessage = bodyMessage;
        if (isGroupMessage && bodyMessage) {
          const mentionedJids = extractChatwootIngressMentionJids(body);
          if (mentionedJids.length > 0) {
            const participants = await this.syncWhatsappGroupParticipants(
              instance,
              provider,
              Number(getConversation),
              body.key.remoteJid,
            );
            chatwootBodyMessage = formatIncomingWhatsappMentions(bodyMessage, mentionedJids, participants);
          }
        }

        if (isMedia) {
          const downloadBase64 = await waInstance?.getBase64FromMediaMessage({
            message: {
              ...body,
            },
          });

          let nameFile: string;
          const messageBody = body?.message[body?.messageType];
          const originalFilename =
            messageBody?.fileName || messageBody?.filename || messageBody?.message?.documentMessage?.fileName;
          if (originalFilename) {
            const parsedFile = path.parse(originalFilename);
            if (parsedFile.name && parsedFile.ext) {
              nameFile = `${parsedFile.name}-${Math.floor(Math.random() * (99 - 10 + 1) + 10)}${parsedFile.ext}`;
            }
          }

          if (!nameFile) {
            nameFile = `${Math.random().toString(36).substring(7)}.${mimeTypes.extension(downloadBase64.mimetype) || ''}`;
          }

          const fileData = Buffer.from(downloadBase64.base64, 'base64');

          const fileStream = new Readable();
          fileStream._read = () => {};
          fileStream.push(fileData);
          fileStream.push(null);

          if (body.key.remoteJid.includes('@g.us')) {
            const content = body.key.fromMe
              ? chatwootBodyMessage || ''
              : formatWhatsappGroupContent(body, chatwootBodyMessage, i18next.t('cw.contactMessage.contact'));

            const send = await this.sendData(
              getConversation,
              fileStream,
              nameFile,
              messageType,
              content,
              instance,
              body,
              'WAID:' + body.key.id,
              quotedMsg,
              provider,
              clientSent,
            );

            if (!send) {
              this.logger.warn('message not sent');
              return;
            }

            return send;
          } else {
            const send = await this.sendData(
              getConversation,
              fileStream,
              nameFile,
              messageType,
              bodyMessage,
              instance,
              body,
              'WAID:' + body.key.id,
              quotedMsg,
              provider,
              clientSent,
            );

            if (!send) {
              this.logger.warn('message not sent');
              return;
            }

            return send;
          }
        }

        if (reactionMessage) {
          await this.applyNativeChatwootReaction(instance, Number(getConversation), body, reactionMessage);
          return;
        }

        if (isInteractiveButtonMessage) {
          const buttons = body.message.interactiveMessage.nativeFlowMessage.buttons;
          this.logger.info('is Interactive Button Message: ' + JSON.stringify(buttons));

          for (const button of buttons) {
            const buttonParams = JSON.parse(button.buttonParamsJson);
            const paymentSettings = buttonParams.payment_settings;

            if (button.name === 'payment_info' && paymentSettings[0].type === 'pix_static_code') {
              const pixSettings = paymentSettings[0].pix_static_code;
              const pixKeyType = (() => {
                switch (pixSettings.key_type) {
                  case 'EVP':
                    return 'Chave Aleatória';
                  case 'EMAIL':
                    return 'E-mail';
                  case 'PHONE':
                    return 'Telefone';
                  default:
                    return pixSettings.key_type;
                }
              })();
              const pixKey = pixSettings.key_type === 'PHONE' ? pixSettings.key.replace('+55', '') : pixSettings.key;
              const content = `*${pixSettings.merchant_name}*\nChave PIX: ${pixKey} (${pixKeyType})`;

              const send = await this.createMessage(
                instance,
                getConversation,
                content,
                messageType,
                false,
                [],
                body,
                'WAID:' + body.key.id,
                quotedMsg,
                clientSent,
              );
              if (!send) this.logger.warn('message not sent');
            } else {
              this.logger.warn('Interactive Button Message not mapped');
            }
          }
          return;
        }

        const isAdsMessage = (adsMessage && adsMessage.title) || adsMessage.body || adsMessage.thumbnailUrl;
        if (isAdsMessage) {
          const imgBuffer = await axios.get(adsMessage.thumbnailUrl, { responseType: 'arraybuffer' });

          const extension = mimeTypes.extension(imgBuffer.headers['content-type']);
          const mimeType = extension && mimeTypes.lookup(extension);

          if (!mimeType) {
            this.logger.warn('mimetype of Ads message not found');
            return;
          }

          const random = Math.random().toString(36).substring(7);
          const nameFile = `${random}.${mimeTypes.extension(mimeType)}`;
          const fileData = Buffer.from(imgBuffer.data, 'binary');

          const img = await Jimp.read(fileData);
          await img.cover({
            w: 320,
            h: 180,
          });
          const processedBuffer = await img.getBuffer(JimpMime.png);

          const fileStream = new Readable();
          fileStream._read = () => {}; // _read is required but you can noop it
          fileStream.push(processedBuffer);
          fileStream.push(null);

          const truncStr = (str: string, len: number) => {
            if (!str) return '';

            return str.length > len ? str.substring(0, len) + '...' : str;
          };

          const title = truncStr(adsMessage.title, 40);
          const description = truncStr(adsMessage?.body, 75);

          const send = await this.sendData(
            getConversation,
            fileStream,
            nameFile,
            messageType,
            `${bodyMessage}\n\n\n**${title}**\n${description}\n${adsMessage.sourceUrl}`,
            instance,
            body,
            'WAID:' + body.key.id,
            null,
            provider,
            clientSent,
          );

          if (!send) {
            this.logger.warn('message not sent');
            return;
          }

          return send;
        }

        if (body.key.remoteJid.includes('@g.us')) {
          const content = body.key.fromMe
            ? `${chatwootBodyMessage}`
            : formatWhatsappGroupContent(body, chatwootBodyMessage, i18next.t('cw.contactMessage.contact'));

          const send = await this.createMessage(
            instance,
            getConversation,
            content,
            messageType,
            false,
            [],
            body,
            'WAID:' + body.key.id,
            quotedMsg,
            clientSent,
          );

          if (!send) {
            this.logger.warn('message not sent');
            return;
          }

          return send;
        } else {
          const send = await this.createMessage(
            instance,
            getConversation,
            bodyMessage,
            messageType,
            false,
            [],
            body,
            'WAID:' + body.key.id,
            quotedMsg,
            clientSent,
          );

          if (!send) {
            this.logger.warn('message not sent');
            return;
          }

          return send;
        }
      }

      if (event === Events.MESSAGES_DELETE) {
        const chatwootDelete = this.configService.get<Chatwoot>('CHATWOOT').MESSAGE_DELETE;

        if (chatwootDelete === true) {
          if (!body?.key?.id) {
            this.logger.warn('message id not found');
            return;
          }

          const message = await this.getMessageByKeyId(instance, body.key.id);

          if (message?.chatwootMessageId && message?.chatwootConversationId) {
            await confirmProviderDeletionBeforeDroppingMapping({
              softDelete: () =>
                this.privilegedChatwootRequest(provider, {
                  method: 'DELETE',
                  path: `/api/v1/accounts/${provider.accountId}/conversations/${message.chatwootConversationId}/messages/${message.chatwootMessageId}`,
                  data: { skip_native: true, provider_source: 'whatsapp' },
                }),
              dropMapping: () =>
                this.prismaRepository.message.deleteMany({
                  where: {
                    key: {
                      path: ['id'],
                      equals: body.key.id,
                    },
                    instanceId: instance.instanceId,
                  },
                }),
            });
            return { message: 'deleted' };
          }
        }
      }

      if (event === 'messages.edit' || event === 'send.message.update') {
        const editedMessageContentRaw =
          body?.editedMessage?.conversation ??
          body?.editedMessage?.extendedTextMessage?.text ??
          body?.editedMessage?.imageMessage?.caption ??
          body?.editedMessage?.videoMessage?.caption ??
          body?.editedMessage?.documentMessage?.caption ??
          (typeof body?.text === 'string' ? body.text : undefined);

        if (typeof editedMessageContentRaw !== 'string') return;

        const message = await this.getMessageByKeyId(instance, body?.key?.id);
        if (!message?.chatwootConversationId || !message?.chatwootMessageId) {
          throw new Error('Provider edit has no mapped Chatwoot message');
        }

        // Edit the original row; a notice must never reuse its provider identity.
        await this.applyWhatsappProviderEdit(provider, {
          messageId: message.chatwootMessageId,
          conversationId: message.chatwootConversationId,
          content: editedMessageContentRaw,
          sourceId: toChatwootSourceId(body.key.id),
          direction: (message.key as WAMessageKey).fromMe ? 'outgoing' : 'incoming',
        });
        return;
      }

      if (event === 'messages.read') {
        if (!body?.key?.id || !body?.key?.remoteJid) {
          this.logger.warn('message id not found');
          return;
        }

        const message = await this.getMessageByKeyId(instance, body.key.id);
        const conversationId = message?.chatwootConversationId;
        const contactInboxSourceId = message?.chatwootContactInboxSourceId;

        if (conversationId) {
          let sourceId = contactInboxSourceId;
          const inbox = (await this.getInbox(instance)) as inbox & {
            inbox_identifier?: string;
          };

          if (!sourceId && inbox) {
            const conversation = (await client.conversations.get({
              accountId: Number(provider.accountId),
              conversationId: conversationId,
            })) as conversation_show & {
              last_non_activity_message: { conversation: { contact_inbox: contact_inboxes } };
            };
            sourceId = conversation.last_non_activity_message?.conversation?.contact_inbox?.source_id;
          }

          if (sourceId && inbox?.inbox_identifier) {
            const url =
              `/public/api/v1/inboxes/${inbox.inbox_identifier}/contacts/${sourceId}` +
              `/conversations/${conversationId}/update_last_seen`;
            await chatwootRequest(this.getClientCwConfig(provider), {
              method: 'POST',
              url: url,
            });
          }
        }
        return;
      }

      if (event === 'groups.upsert') {
        this.scheduleParticipatingGroups(
          instance,
          (Array.isArray(body) ? body : []).map((group) => group.id),
        );
        return;
      }

      if (event === 'group-participants.update') {
        this.scheduleParticipatingGroups(instance, [body.id]);
        return;
      }

      if (event === 'status.instance') {
        const data = body;
        const inbox = await this.getInbox(instance);

        if (!inbox) {
          this.logger.warn('inbox not found');
          return;
        }

        const msgStatus = i18next.t('cw.inbox.status', {
          inboxName: inbox.name,
          state: data.status,
        });

        await this.createBotMessage(instance, msgStatus, 'incoming');
      }

      if (event === 'connection.update' && body.status === 'open') {
        this.scheduleParticipatingGroups(instance);
        const waInstance = this.waMonitor.waInstances[instance.instanceName];
        if (!waInstance) return;

        const now = Date.now();
        const timeSinceLastNotification = now - (waInstance.lastConnectionNotification || 0);

        // Se a conexão foi estabelecida via QR code, notifica imediatamente.
        if (waInstance.qrCode && waInstance.qrCode.count > 0) {
          const msgConnection = i18next.t('cw.inbox.connected');
          await this.createBotMessage(instance, msgConnection, 'incoming');
          waInstance.qrCode.count = 0;
          waInstance.lastConnectionNotification = now;
          chatwootImport.clearAll(instance);
        }
        // Se não foi via QR code, verifica o throttling.
        else if (timeSinceLastNotification >= 30000) {
          const msgConnection = i18next.t('cw.inbox.connected');
          await this.createBotMessage(instance, msgConnection, 'incoming');
          waInstance.lastConnectionNotification = now;
        } else {
          this.logger.warn(
            `Connection notification skipped for ${instance.instanceName} - too frequent (${timeSinceLastNotification}ms since last)`,
          );
        }
      }

      if (event === 'qrcode.updated') {
        if (body.statusCode === 500) {
          const erroQRcode = `🚨 ${i18next.t('qrlimitreached')}`;
          return await this.createBotMessage(instance, erroQRcode, 'incoming');
        } else {
          const fileData = Buffer.from(body?.qrcode.base64.replace('data:image/png;base64,', ''), 'base64');

          const fileStream = new Readable();
          fileStream._read = () => {};
          fileStream.push(fileData);
          fileStream.push(null);

          await this.createBotQr(
            instance,
            i18next.t('qrgeneratedsuccesfully'),
            'incoming',
            fileStream,
            `${instance.instanceName}.png`,
          );

          let msgQrCode = `⚡️${i18next.t('qrgeneratedsuccesfully')}\n\n${i18next.t('scanqr')}`;

          if (body?.qrcode?.pairingCode) {
            msgQrCode =
              msgQrCode +
              `\n\n*Pairing Code:* ${body.qrcode.pairingCode.substring(0, 4)}-${body.qrcode.pairingCode.substring(
                4,
                8,
              )}`;
          }

          await this.createBotMessage(instance, msgQrCode, 'incoming');
        }
      }
    } catch (error) {
      this.logger.error(error);
    }
  }

  public normalizeJidIdentifier(remoteJid: string) {
    if (!remoteJid) {
      return '';
    }
    if (remoteJid.includes('@lid')) {
      return remoteJid;
    }
    return remoteJid.replace(/:\d+/, '').split('@')[0];
  }

  public startImportHistoryMessages(instance: InstanceDto) {
    if (!this.isImportHistoryAvailable()) {
      return;
    }

    this.createBotMessage(instance, i18next.t('cw.import.startImport'), 'incoming');
  }

  public isImportHistoryAvailable() {
    const uri = this.configService.get<Chatwoot>('CHATWOOT').IMPORT.DATABASE.CONNECTION.URI;

    return uri && uri !== 'postgres://user:password@hostname:port/dbname';
  }

  public addHistoryMessages(instance: InstanceDto, messagesRaw: MessageModel[]) {
    if (!this.isImportHistoryAvailable()) {
      return;
    }

    chatwootImport.addHistoryMessages(instance, messagesRaw);
  }

  public addHistoryContacts(instance: InstanceDto, contactsRaw: ContactModel[]) {
    if (!this.isImportHistoryAvailable()) {
      return;
    }

    return chatwootImport.addHistoryContacts(instance, contactsRaw);
  }

  public async importHistoryMessages(instance: InstanceDto) {
    if (!this.isImportHistoryAvailable()) {
      return;
    }

    const releaseCapacity = await acquireFullHistoryCapacity();
    const releaseWriter = await acquireHistoryWriter(instance.instanceName);
    try {
      this.createBotMessage(instance, i18next.t('cw.import.importingMessages'), 'incoming');

      const provider = await this.getProvider(instance);
      const inbox = await this.getInbox(instance);
      if (!provider || !inbox) {
        this.logger.warn('Chatwoot provider or inbox not found');
        return null;
      }

      const totalMessagesImported = await chatwootImport.importHistoryMessages(instance, this, inbox, provider);
      this.updateContactAvatarInRecentConversations(instance);

      const msg = Number.isInteger(totalMessagesImported)
        ? i18next.t('cw.import.messagesImported', { totalMessagesImported })
        : i18next.t('cw.import.messagesException');

      this.createBotMessage(instance, msg, 'incoming');

      return totalMessagesImported;
    } finally {
      releaseWriter();
      releaseCapacity();
    }
  }

  public async updateContactAvatarInRecentConversations(instance: InstanceDto, limitContacts = 100) {
    try {
      if (!this.isImportHistoryAvailable()) {
        return;
      }

      const context = await this.clientCw(instance);
      if (!context) {
        this.logger.warn('client not found');
        return null;
      }
      const { client, provider } = context;

      const inbox = await this.getInbox(instance);
      if (!inbox) {
        this.logger.warn('inbox not found');
        return null;
      }

      const recentContacts = await chatwootImport.getContactsOrderByRecentConversations(inbox, provider, limitContacts);

      const contactIdentifiers = recentContacts
        .map((contact) => contact.identifier)
        .filter((identifier) => identifier !== null);

      const contactsWithProfilePicture = (
        await this.prismaRepository.contact.findMany({
          where: {
            instanceId: instance.instanceId,
            id: {
              in: contactIdentifiers,
            },
            profilePicUrl: {
              not: null,
            },
          },
        })
      ).reduce((acc: Map<string, ContactModel>, contact: ContactModel) => acc.set(contact.id, contact), new Map());

      recentContacts.forEach(async (contact) => {
        if (contactsWithProfilePicture.has(contact.identifier)) {
          client.contacts.update({
            accountId: Number(provider.accountId),
            id: contact.id,
            data: {
              avatar_url: contactsWithProfilePicture.get(contact.identifier).profilePictureUrl || null,
            },
          });
        }
      });
    } catch (error) {
      this.logger.error(`Error on update avatar in recent conversations: ${error.toString()}`);
    }
  }

  private async resolvePhoneJidForLid(instance: InstanceDto, lid: string) {
    const waInstance = this.waMonitor.waInstances[instance.instanceName] as any;
    const resolved = await waInstance?.resolvePhoneJidForLid?.(lid);
    return isPhoneJid(resolved) ? resolved : null;
  }

  private async refreshKnownLidMappings(instance: InstanceDto, mappingMessages: Pick<MessageModel, 'key'>[]) {
    const phoneJids = new Set<string>();
    for (const message of mappingMessages) {
      const key = message.key as { remoteJid?: string; remoteJidAlt?: string };
      if (isPhoneJid(key?.remoteJid)) {
        phoneJids.add(toCanonicalHistoryJid(key.remoteJid));
      }
      if (isPhoneJid(key?.remoteJidAlt)) {
        phoneJids.add(toCanonicalHistoryJid(key.remoteJidAlt));
      }
    }

    const [contacts, chats] = await Promise.all([
      this.prismaRepository.contact.findMany({
        where: { Instance: { name: instance.instanceName }, remoteJid: { endsWith: '@s.whatsapp.net' } },
        select: { remoteJid: true },
      }),
      this.prismaRepository.chat.findMany({
        where: { Instance: { name: instance.instanceName }, remoteJid: { endsWith: '@s.whatsapp.net' } },
        select: { remoteJid: true },
      }),
    ]);
    contacts.forEach((contact) => phoneJids.add(toCanonicalHistoryJid(contact.remoteJid)));
    chats.forEach((chat) => phoneJids.add(toCanonicalHistoryJid(chat.remoteJid)));

    const waInstance = this.waMonitor.waInstances[instance.instanceName] as any;
    const result = await waInstance?.refreshLidMappingsForPhoneJids?.(Array.from(phoneJids));
    return {
      attemptedPhoneJids: phoneJids.size,
      refreshedMappings: Number(result?.refreshedMappings || 0),
    };
  }

  private async getGroupIdentityNames(instance: InstanceDto, messages: MessageModel[]) {
    const groupJids = Array.from(
      new Set(
        messages
          .map((message) => (message.key as { remoteJid?: string })?.remoteJid)
          .filter((remoteJid): remoteJid is string => isGroupJid(remoteJid)),
      ),
    );
    const identityNames = new Map<string, string>();
    if (groupJids.length === 0) {
      return identityNames;
    }

    const storedGroups = await this.prismaRepository.chat.findMany({
      where: {
        Instance: { name: instance.instanceName },
        remoteJid: { in: groupJids },
      },
      select: { remoteJid: true, name: true },
    });
    storedGroups.forEach((group) => {
      if (group.name?.trim()) {
        identityNames.set(group.remoteJid, group.name.trim());
      }
    });

    const waInstance = this.waMonitor.waInstances[instance.instanceName] as any;
    const missingGroupJids = groupJids.filter((groupJid) => !identityNames.has(groupJid));
    const batchSize = 5;
    for (let offset = 0; offset < missingGroupJids.length; offset += batchSize) {
      const batch = missingGroupJids.slice(offset, offset + batchSize);
      const groupNames = await Promise.all(
        batch.map(async (groupJid) => {
          try {
            return [groupJid, await waInstance?.resolveGroupName?.(groupJid)] as const;
          } catch {
            return [groupJid, null] as const;
          }
        }),
      );
      groupNames.forEach(([groupJid, groupName]) => {
        if (groupName?.trim()) {
          identityNames.set(groupJid, groupName.trim());
        }
      });
    }

    return identityNames;
  }

  private async enableExtendedHistorySync(instance: InstanceDto) {
    await this.cache.hSet(this.extendedHistorySyncKey, instance.instanceName, true);
  }

  private async isExtendedHistorySyncEnabled(instance: InstanceDto) {
    return Boolean(await this.cache.hGet(this.extendedHistorySyncKey, instance.instanceName));
  }

  private async removeUnresolvedLidLabel(contactId: number) {
    await this.pgClient.query(
      `WITH target_tag AS (
         SELECT id FROM tags WHERE name = 'unresolved_lid' LIMIT 1
       ),
       removed AS (
         DELETE FROM taggings
         WHERE tag_id = (SELECT id FROM target_tag)
           AND taggable_type = 'Contact'
           AND taggable_id = $1
           AND context = 'labels'
         RETURNING tag_id
       )
       UPDATE tags
       SET taggings_count = (
         SELECT COUNT(*) FROM taggings
         WHERE taggings.tag_id = tags.id
           AND taggings.context = 'labels'
       )
       WHERE id = (SELECT id FROM target_tag)`,
      [contactId],
    );
  }

  public async reconcileLidIdentity(instance: InstanceDto, lid: string, phoneJid: string) {
    if (!isLidJid(lid) || !isPhoneJid(phoneJid)) {
      return { status: 'invalid_mapping' };
    }

    const context = await this.clientCw(instance);
    if (!context) {
      return { status: 'chatwoot_unavailable' };
    }
    const { provider } = context;

    const canonicalLid = toCanonicalHistoryJid(lid);
    const canonicalPhoneJid = toCanonicalHistoryJid(phoneJid);
    const provisionalContact = await this.findContactByIdentifier(instance, canonicalLid);
    if (!provisionalContact?.id) {
      return { status: 'no_provisional_contact' };
    }

    const phoneNumber = canonicalPhoneJid.split('@')[0].split(':')[0];
    const canonicalContact =
      (await this.findContactByIdentifier(instance, canonicalPhoneJid)) ||
      (await this.findContact(instance, phoneNumber));

    if (canonicalContact?.id && canonicalContact.id !== provisionalContact.id) {
      const merged = await this.mergeContacts(canonicalContact.id, provisionalContact.id, provider);
      if (!merged) {
        throw new Error(`Unable to merge provisional Chatwoot LID contact for ${instance.instanceName}`);
      }
      await this.removeUnresolvedLidLabel(canonicalContact.id);
      return { status: 'merged' };
    }

    await this.updateContact(instance, provisionalContact.id, {
      identifier: canonicalPhoneJid,
      phone_number: `+${phoneNumber}`,
    });
    const updatedContact = await this.findContactByIdentifier(instance, canonicalPhoneJid);
    if (updatedContact?.id !== provisionalContact.id) {
      throw new Error(`Unable to update provisional Chatwoot LID contact for ${instance.instanceName}`);
    }

    await this.removeUnresolvedLidLabel(provisionalContact.id);
    return { status: 'updated' };
  }

  public async reconcileStoredLidContacts(instance: InstanceDto) {
    if (!this.isImportHistoryAvailable()) {
      return { checked: 0, reconciled: 0, failed: 0 };
    }

    const provider = await this.getProvider(instance);
    const inbox = await this.getInbox(instance);
    if (!provider?.enabled || !inbox) {
      return { checked: 0, reconciled: 0, failed: 0 };
    }

    const provisionalContacts = (
      await this.pgClient.query(
        `SELECT DISTINCT contacts.identifier
         FROM contacts
         JOIN contact_inboxes ON contact_inboxes.contact_id = contacts.id
         WHERE contacts.account_id = $1
           AND contact_inboxes.inbox_id = $2
           AND (
             contacts.identifier LIKE '%@lid'
             OR contacts.identifier LIKE '%@hosted.lid'
           )`,
        [provider.accountId, inbox.id],
      )
    ).rows as Array<{ identifier: string }>;

    let reconciled = 0;
    let failed = 0;
    for (const contact of provisionalContacts) {
      try {
        const phoneJid = await this.resolvePhoneJidForLid(instance, contact.identifier);
        if (!phoneJid) {
          continue;
        }
        const result = await this.reconcileLidIdentity(instance, contact.identifier, phoneJid);
        if (result.status === 'merged' || result.status === 'updated') {
          reconciled++;
        }
      } catch (error) {
        failed++;
        this.logger.error(
          `Unable to reconcile stored Chatwoot LID contact ${contact.identifier}: ${formatCaughtError(error)}`,
        );
      }
    }

    return { checked: provisionalContacts.length, reconciled, failed };
  }

  public async syncStoredHistory(instance: InstanceDto, data: ChatwootHistorySyncDto = {}) {
    if (!this.isImportHistoryAvailable()) {
      throw new BadRequestException('Chatwoot history import database connection is not configured');
    }

    const releaseWriter = await acquireHistoryWriter(instance.instanceName);
    try {
      const provider = await this.getProvider(instance);
      if (!provider?.importMessages) {
        throw new BadRequestException(`Chatwoot message import is disabled for ${instance.instanceName}`);
      }

      const context = await this.clientCw(instance);
      if (!context) {
        throw new BadRequestException(`Chatwoot client is not available for ${instance.instanceName}`);
      }

      const inbox = await this.getInbox(instance);
      if (!inbox) {
        throw new BadRequestException(`Chatwoot inbox is not available for ${instance.instanceName}`);
      }
      const sinceTimestamp = data.since ? dayjs(data.since).unix() : null;
      if (data.since && (!dayjs(data.since).isValid() || sinceTimestamp <= 0)) {
        throw new BadRequestException('since must be a valid ISO-8601 timestamp');
      }

      const savedMessages = await this.prismaRepository.message.findMany({
        where: {
          Instance: { name: instance.instanceName },
          ...(sinceTimestamp ? { messageTimestamp: { gte: Number(sinceTimestamp) } } : {}),
        },
        orderBy: [{ messageTimestamp: 'asc' }, { id: 'asc' }],
      });

      const mappingMessages =
        sinceTimestamp === null
          ? savedMessages
          : await this.prismaRepository.message.findMany({
              where: { Instance: { name: instance.instanceName } },
              select: { key: true },
            });

      const scope = data.scope || 'direct';
      const unresolvedLidMode = data.unresolvedLidMode || 'skip';
      const lidMappingRefresh = data.refreshLidMappings
        ? await this.refreshKnownLidMappings(instance, mappingMessages)
        : { attemptedPhoneJids: 0, refreshedMappings: 0 };

      const normalized = await normalizeStoredHistoryMessages(
        savedMessages,
        mappingMessages,
        (lid) => this.resolvePhoneJidForLid(instance, lid),
        {
          retainProviderAliases: this.configService.get<Chatwoot>('CHATWOOT').PROVIDER_CONVERSATION_BINDINGS,
          includeGroups: scope === 'groups' || scope === 'all',
          includeUnresolvedLids: unresolvedLidMode === 'provisional' && (scope === 'direct' || scope === 'all'),
        },
      );

      let targetRemoteJid: string | null | undefined = data.remoteJid;
      if (isLidJid(targetRemoteJid)) {
        const storedMapping = buildStoredLidMap(mappingMessages).get(targetRemoteJid);
        const resolvedMapping = storedMapping || (await this.resolvePhoneJidForLid(instance, targetRemoteJid));
        targetRemoteJid =
          resolvedMapping || (unresolvedLidMode === 'provisional' ? toCanonicalHistoryJid(targetRemoteJid) : null);
      } else if (targetRemoteJid) {
        targetRemoteJid = toCanonicalHistoryJid(targetRemoteJid);
      }

      const scopedMessages = normalized.messages.filter((message: any) => {
        const remoteJid = message.key?.remoteJid;
        if (scope === 'groups') {
          return isGroupJid(remoteJid);
        }
        if (scope === 'direct') {
          return !isGroupJid(remoteJid);
        }
        return true;
      });

      const routeMessages =
        data.remoteJid && !targetRemoteJid
          ? []
          : targetRemoteJid
            ? scopedMessages.filter((message: any) => message.key?.remoteJid === targetRemoteJid)
            : scopedMessages;

      const existingSourceIds = await chatwootImport.getExistingSourceIds(
        routeMessages.map((message: any) => message.key.id),
        undefined,
        inbox.id,
      );

      const missingMessages = routeMessages.filter(
        (message: any) => !existingSourceIds.has(toChatwootSourceId(message.key.id)),
      );
      const importableMessagesWithDuplicates = missingMessages.filter((message: any) =>
        Boolean(chatwootImport.getContentMessage(this, message)),
      );
      const { messages: importableMessages, duplicateMessages: duplicateSourceMessagesSkipped } =
        dedupeHistoryMessagesBySourceId(importableMessagesWithDuplicates);
      const selectedMessages = data.limit ? importableMessages.slice(0, data.limit) : importableMessages;
      const dryRun = data.dryRun !== false;
      const selectedGroupMessages = selectedMessages.filter((message: any) =>
        isGroupJid(message.key?.remoteJid),
      ).length;
      const selectedProvisionalLidMessages = selectedMessages.filter((message: any) =>
        isLidJid(message.key?.remoteJid),
      ).length;

      const result = {
        status: dryRun ? 'dry_run' : 'completed',
        instanceName: instance.instanceName,
        inboxId: inbox.id,
        providerEnabled: Boolean(provider.enabled),
        since: data.since || null,
        scope,
        unresolvedLidMode,
        attemptedPhoneJids: lidMappingRefresh.attemptedPhoneJids,
        refreshedLidMappings: lidMappingRefresh.refreshedMappings,
        remoteJidFiltered: Boolean(data.remoteJid),
        sourceMessages: normalized.stats.sourceMessages,
        directMessages: normalized.stats.directMessages,
        groupMessages: normalized.stats.groupMessages,
        groupMessagesSkipped: scope === 'direct' ? normalized.stats.groupMessages : 0,
        systemMessagesSkipped: normalized.stats.systemMessages,
        invalidMessagesSkipped: normalized.stats.invalidMessages,
        unresolvedLidMessages: normalized.stats.unresolvedLidMessages,
        unresolvedLidChats: normalized.stats.unresolvedLidChats,
        provisionalLidMessages: normalized.stats.provisionalLidMessages,
        unresolvedLidMessagesSkipped:
          unresolvedLidMode === 'provisional' && scope !== 'groups' ? 0 : normalized.stats.unresolvedLidMessages,
        unresolvedLidChatsSkipped:
          unresolvedLidMode === 'provisional' && scope !== 'groups' ? 0 : normalized.stats.unresolvedLidChats,
        normalizedMessages: normalized.stats.normalizedMessages,
        routeMessages: routeMessages.length,
        existingMessages: routeMessages.length - missingMessages.length,
        unsupportedMessagesSkipped: missingMessages.length - importableMessagesWithDuplicates.length,
        duplicateSourceMessagesSkipped,
        selectedMessages: selectedMessages.length,
        selectedGroupMessages,
        selectedProvisionalLidMessages,
        importedMessages: 0,
        appliedMessages: 0,
      };

      if (dryRun) {
        return result;
      }
      if (selectedMessages.length === 0) {
        if (scope === 'all' && unresolvedLidMode === 'provisional') {
          await this.enableExtendedHistorySync(instance);
        }
        return result;
      }

      const identityNames = await this.getGroupIdentityNames(instance, selectedMessages);
      const importedMessages = await chatwootImport.importHistoryMessages(instance, this, inbox, provider, {
        messages: selectedMessages,
        identityNames,
      });
      if (!Number.isInteger(importedMessages)) {
        throw new Error(`Chatwoot history import failed for ${instance.instanceName}`);
      }

      const appliedSourceIds = await chatwootImport.getExistingSourceIds(
        selectedMessages.map((message: any) => message.key.id),
        undefined,
        inbox.id,
      );
      if (appliedSourceIds.size !== selectedMessages.length) {
        throw new Error(
          `Chatwoot history import only applied ${appliedSourceIds.size}/${selectedMessages.length} messages for ${instance.instanceName}`,
        );
      }

      const waInstance = this.waMonitor.waInstances[instance.instanceName];
      await waInstance?.clearCacheChatwoot?.();
      result.importedMessages = Number(importedMessages);
      result.appliedMessages = appliedSourceIds.size;
      if (scope === 'all' && unresolvedLidMode === 'provisional') {
        await this.enableExtendedHistorySync(instance);
      }

      return result;
    } finally {
      releaseWriter();
    }
  }

  public async syncStoredHistoryBatch(instance: InstanceDto, data: ChatwootHistorySyncBatchDto) {
    if (!this.isImportHistoryAvailable()) {
      throw new BadRequestException('Chatwoot history import database connection is not configured');
    }
    if (data.contractVersion !== '2026-08-01' || data.dryRun !== false) {
      throw new BadRequestException('Unsupported Chatwoot cached history batch contract');
    }
    const releaseWriter = tryAcquireHistoryWriter(instance.instanceName);
    if (!releaseWriter) {
      throw new BadRequestException(`Chatwoot history sync is already running for ${instance.instanceName}`);
    }
    try {
      const provider = await this.getProvider(instance);
      if (!provider?.importMessages) {
        throw new BadRequestException(`Chatwoot message import is disabled for ${instance.instanceName}`);
      }

      const context = await this.clientCw(instance);
      if (!context) {
        throw new BadRequestException(`Chatwoot client is not available for ${instance.instanceName}`);
      }
      const inbox = await this.getInbox(instance);
      if (!inbox) {
        throw new BadRequestException(`Chatwoot inbox is not available for ${instance.instanceName}`);
      }

      const requestedSourceIds = new Set<string>();
      const requestedDatabaseIds = new Set<string>();
      for (const entry of data.messages) {
        const databaseId = String(entry.message.id || '');
        const key = entry.message.key as { id?: unknown };
        const canonicalSourceId = typeof key?.id === 'string' ? toChatwootSourceId(key.id) : '';
        if (!databaseId || canonicalSourceId !== entry.sourceId) {
          throw new BadRequestException('Cached history message source id does not match its embedded payload');
        }
        if (requestedSourceIds.has(entry.sourceId) || requestedDatabaseIds.has(databaseId)) {
          throw new BadRequestException('Cached history batch contains duplicate messages');
        }
        requestedSourceIds.add(entry.sourceId);
        requestedDatabaseIds.add(databaseId);
      }

      const storedMessages = await this.prismaRepository.message.findMany({
        where: {
          Instance: { name: instance.instanceName },
          id: { in: Array.from(requestedDatabaseIds) },
        },
      });
      const storedById = new Map(storedMessages.map((message) => [message.id, message]));
      const authoritativeMessages = data.messages.map((entry) => {
        const stored = storedById.get(String(entry.message.id));
        const storedKey = stored?.key as { id?: unknown } | undefined;
        if (!stored || typeof storedKey?.id !== 'string' || toChatwootSourceId(storedKey.id) !== entry.sourceId) {
          throw new BadRequestException('Cached history message is not available for the requested instance');
        }
        return stored;
      });

      const lidMappingRefresh = data.refreshLidMappings
        ? await this.refreshKnownLidMappings(instance, authoritativeMessages)
        : { attemptedPhoneJids: 0, refreshedMappings: 0 };
      const normalized = await normalizeStoredHistoryMessages(
        authoritativeMessages,
        authoritativeMessages,
        (lid) => this.resolvePhoneJidForLid(instance, lid),
        {
          retainProviderAliases: this.configService.get<Chatwoot>('CHATWOOT').PROVIDER_CONVERSATION_BINDINGS,
          includeGroups: data.scope === 'groups' || data.scope === 'all',
          includeUnresolvedLids:
            data.unresolvedLidMode === 'provisional' && (data.scope === 'direct' || data.scope === 'all'),
        },
      );
      const scopedMessages = normalized.messages.filter((message: any) => {
        const remoteJid = message.key?.remoteJid;
        if (data.scope === 'groups') return isGroupJid(remoteJid);
        if (data.scope === 'direct') return !isGroupJid(remoteJid);
        return true;
      });
      const { messages: uniqueMessages, duplicateMessages: duplicateSourceMessagesSkipped } =
        dedupeHistoryMessagesBySourceId(scopedMessages);
      const existingSourceIds = await chatwootImport.getExistingSourceIds(
        Array.from(requestedSourceIds),
        undefined,
        inbox.id,
      );
      const missingMessages = uniqueMessages.filter(
        (message: any) => !existingSourceIds.has(toChatwootSourceId(message.key.id)),
      );
      const importableMessages = missingMessages.filter((message: any) =>
        Boolean(chatwootImport.getContentMessage(this, message)),
      );

      let importedMessages = 0;
      let appliedMessages = 0;
      if (importableMessages.length > 0) {
        const identityNames = await this.getGroupIdentityNames(instance, importableMessages);
        const imported = await chatwootImport.importHistoryMessages(instance, this, inbox, provider, {
          messages: importableMessages,
          identityNames,
        });
        if (!Number.isInteger(imported)) {
          throw new Error(`Chatwoot cached history import failed for ${instance.instanceName}`);
        }
        importedMessages = Number(imported);
        const appliedSourceIds = await chatwootImport.getExistingSourceIds(
          importableMessages.map((message: any) => message.key.id),
          undefined,
          inbox.id,
        );
        if (appliedSourceIds.size !== importableMessages.length) {
          throw new Error(
            `Chatwoot cached history import only applied ${appliedSourceIds.size}/${importableMessages.length} messages for ${instance.instanceName}`,
          );
        }
        appliedMessages = appliedSourceIds.size;
        await this.waMonitor.waInstances[instance.instanceName]?.clearCacheChatwoot?.();
      }
      if (data.scope === 'all' && data.unresolvedLidMode === 'provisional') {
        await this.enableExtendedHistorySync(instance);
      }

      return {
        contractVersion: '2026-08-01',
        status: 'completed',
        instanceName: instance.instanceName,
        inboxId: inbox.id,
        providerEnabled: Boolean(provider.enabled),
        scope: data.scope,
        unresolvedLidMode: data.unresolvedLidMode,
        attemptedPhoneJids: lidMappingRefresh.attemptedPhoneJids,
        refreshedLidMappings: lidMappingRefresh.refreshedMappings,
        sourceMessages: data.messages.length,
        existingMessages: existingSourceIds.size,
        selectedMessages: data.messages.length,
        importedMessages,
        appliedMessages,
        unsupportedMessagesSkipped: missingMessages.length - importableMessages.length,
        duplicateSourceMessagesSkipped,
        processedSourceIds: Array.from(requestedSourceIds),
      };
    } finally {
      releaseWriter();
    }
  }

  private async getStoredHistoryRecoveryInbox(provider: ChatwootModel): Promise<inbox | null> {
    const result = await this.pgClient.query('SELECT id FROM inboxes WHERE account_id = $1 AND name = $2 ORDER BY id', [
      provider.accountId,
      provider.nameInbox,
    ]);
    const inboxId = uniqueHistoryRecoveryInboxId(result?.rows || []);
    if (!inboxId) {
      this.logger.warn(
        `Expected exactly one Chatwoot recovery inbox for account ${provider.accountId} and name ${provider.nameInbox}`,
      );
      return null;
    }

    return { id: inboxId } as inbox;
  }

  public async getStoredHistoryRecoveryCapability(instance: InstanceDto) {
    if (!this.isImportHistoryAvailable()) {
      throw new BadRequestException('Chatwoot history import database connection is not configured');
    }
    const provider = await this.getProvider(instance);
    if (!provider?.importMessages) {
      throw new BadRequestException(`Chatwoot message import is disabled for ${instance.instanceName}`);
    }
    const inbox = await this.getStoredHistoryRecoveryInbox(provider);
    if (!inbox) {
      throw new BadRequestException(`Chatwoot inbox is not available for ${instance.instanceName}`);
    }
    return {
      contractVersion: '2026-08-28',
      maxBatchSize: 500,
      operation: 'destination-aware-recovery',
      recoveryModes: ['standard', 'maximize'],
      ...historyRecoveryDestination(provider.accountId, inbox.id),
    };
  }

  public async reconcileStoredHistoryMappings(instance: InstanceDto, data: ChatwootHistoryMappingReconcileDto) {
    if (
      !this.isImportHistoryAvailable() ||
      !this.configService.get<Chatwoot>('CHATWOOT').PROVIDER_CONVERSATION_BINDINGS ||
      data.contractVersion !== '2026-10-08' ||
      typeof data.dryRun !== 'boolean' ||
      !Array.isArray(data.messages) ||
      data.messages.length < 1 ||
      data.messages.length > 250
    )
      throw new BadRequestException('Invalid bounded history mapping contract');
    const releaseWriter = tryAcquireHistoryWriter(instance.instanceName);
    if (!releaseWriter) throw new BadRequestException('Chatwoot history writer is already running');
    try {
      const provider = await this.getProvider(instance);
      if (!provider?.enabled || !provider.importMessages)
        throw new BadRequestException('Chatwoot history import is disabled');
      const inbox = await this.getStoredHistoryRecoveryInbox(provider);
      if (
        !inbox ||
        !matchesHistoryRecoveryDestination(
          data.expectedDestinationKey,
          data.expectedInboxId,
          provider.accountId,
          inbox.id,
        )
      )
        throw new BadRequestException('Chatwoot history mapping destination changed');
      const ids = data.messages.map((entry) => String(entry.message?.id || ''));
      const sources = data.messages.map((entry) => entry.sourceId);
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length || new Set(sources).size !== sources.length)
        throw new BadRequestException('History mapping batch contains duplicate or absent identities');
      const stored = await this.prismaRepository.message.findMany({
        where: { Instance: { name: instance.instanceName }, id: { in: ids } },
      });
      const updates = await this.prismaRepository.messageUpdate.findMany({
        where: { Instance: { name: instance.instanceName }, messageId: { in: ids }, status: 'EDITED' },
        select: { messageId: true },
      });
      const edited = new Set(updates.map((row) => row.messageId));
      const selected = data.messages.map((entry) => {
        const row = stored.find((item) => item.id === entry.message.id);
        const key = row?.key as { id?: string; fromMe?: boolean };
        if (
          !row ||
          typeof key?.id !== 'string' ||
          typeof key.fromMe !== 'boolean' ||
          toChatwootSourceId(key.id) !== entry.sourceId ||
          (key.fromMe ? 'outgoing' : 'incoming') !== entry.expectedDirection ||
          row.messageTimestamp !== entry.message.messageTimestamp ||
          row.messageType !== entry.message.messageType ||
          !isDeepStrictEqual(row.key, entry.message.key) ||
          !isDeepStrictEqual(row.message, entry.message.message) ||
          classifyCachedHistoryRecord(row, row.status === 'EDITED' || edited.has(row.id)) !== 'ordinary'
        )
          throw new BadRequestException('History mapping requires the current exact ordinary source version');
        return row;
      });
      const outcomes = [];
      for (const row of selected)
        outcomes.push(
          await reconcileHistoryMessageBinding(
            postgresClient.getChatwootConnection(),
            this.prismaRepository,
            row,
            Number(provider.accountId),
            inbox.id,
            data.dryRun,
          ),
        );
      return {
        contractVersion: data.contractVersion,
        dryRun: data.dryRun,
        ...historyRecoveryDestination(provider.accountId, inbox.id),
        selectedMessages: selected.length,
        outcomes,
      };
    } finally {
      releaseWriter();
    }
  }

  public async syncStoredHistoryRecoveryBatch(instance: InstanceDto, data: ChatwootHistoryRecoveryBatchDto) {
    if (!this.isImportHistoryAvailable()) {
      throw new BadRequestException('Chatwoot history import database connection is not configured');
    }
    if (data.contractVersion !== '2026-08-28' || data.dryRun !== false) {
      throw new BadRequestException('Unsupported Chatwoot destination-aware recovery contract');
    }
    const releaseWriter = tryAcquireHistoryWriter(instance.instanceName);
    if (!releaseWriter) {
      throw new BadRequestException(`Chatwoot history sync is already running for ${instance.instanceName}`);
    }
    try {
      const provider = await this.getProvider(instance);
      if (!provider?.importMessages) {
        throw new BadRequestException(`Chatwoot message import is disabled for ${instance.instanceName}`);
      }
      const inbox = await this.getStoredHistoryRecoveryInbox(provider);
      if (!inbox) {
        throw new BadRequestException(`Chatwoot inbox is not available for ${instance.instanceName}`);
      }
      const destination = historyRecoveryDestination(provider.accountId, inbox.id);
      if (
        !matchesHistoryRecoveryDestination(
          data.expectedDestinationKey,
          data.expectedInboxId,
          provider.accountId,
          inbox.id,
        )
      ) {
        throw new BadRequestException(
          `Chatwoot destination changed for ${instance.instanceName}; refresh capability before recovery`,
        );
      }

      const requestedSourceIds = new Set<string>();
      const requestedDatabaseIds = new Set<string>();
      for (const entry of data.messages) {
        const databaseId = String(entry.message.id || '');
        const key = entry.message.key as { id?: unknown; fromMe?: unknown };
        const canonicalSourceId = typeof key?.id === 'string' ? toChatwootSourceId(key.id) : '';
        const embeddedDirection = typeof key?.fromMe === 'boolean' ? (key.fromMe ? 'outgoing' : 'incoming') : undefined;
        if (!databaseId || canonicalSourceId !== entry.sourceId || embeddedDirection !== entry.expectedDirection) {
          throw new BadRequestException('Cached history message identity does not match its bound payload');
        }
        if (requestedSourceIds.has(entry.sourceId) || requestedDatabaseIds.has(databaseId)) {
          throw new BadRequestException('Cached history batch contains duplicate messages');
        }
        requestedSourceIds.add(entry.sourceId);
        requestedDatabaseIds.add(databaseId);
      }

      const storedMessages = await this.prismaRepository.message.findMany({
        where: {
          Instance: { name: instance.instanceName },
          id: { in: Array.from(requestedDatabaseIds) },
        },
      });
      const storedById = new Map(storedMessages.map((message) => [message.id, message]));
      const authoritativeMessages = data.messages.map((entry) => {
        const stored = storedById.get(String(entry.message.id));
        const storedKey = stored?.key as { id?: unknown; fromMe?: unknown } | undefined;
        if (!stored || typeof storedKey?.id !== 'string' || toChatwootSourceId(storedKey.id) !== entry.sourceId) {
          throw new BadRequestException('Cached history message is not available for the requested instance');
        }
        const authoritativeDirection =
          typeof storedKey.fromMe === 'boolean' ? (storedKey.fromMe ? 'outgoing' : 'incoming') : undefined;
        if (authoritativeDirection !== entry.expectedDirection) {
          throw new BadRequestException('Cached history message direction changed in authoritative storage');
        }
        if (
          stored.messageTimestamp !== entry.message.messageTimestamp ||
          !isDeepStrictEqual(stored.key, entry.message.key) ||
          !isDeepStrictEqual(stored.message, entry.message.message)
        ) {
          throw new BadRequestException('Cached history source version changed; refresh before recovery');
        }
        return stored;
      });
      const retainedEdits = await this.prismaRepository.messageUpdate.findMany({
        where: {
          Instance: { name: instance.instanceName },
          messageId: { in: Array.from(requestedDatabaseIds) },
          status: 'EDITED',
        },
        select: { messageId: true },
      });
      const editedIds = new Set(retainedEdits.map((edit) => edit.messageId));
      const classifications = new Map(
        authoritativeMessages.map((message) => [
          toChatwootSourceId((message.key as { id: string }).id),
          classifyCachedHistoryRecord(message, message.status === 'EDITED' || editedIds.has(message.id)),
        ]),
      );
      const missingPlaintextOriginals = new Map<
        string,
        { source: MessageModel; proof: IgnoredMissingPlaintextOriginalProof }
      >();
      for (const source of authoritativeMessages) {
        const sourceId = toChatwootSourceId((source.key as { id: string }).id);
        if (classifications.get(sourceId) !== 'plaintext_edit') continue;
        const proof = await captureMissingPlaintextEditOriginal(
          source,
          this.prismaRepository.message,
          Number(provider.accountId),
          inbox.id,
        );
        if (!proof)
          throw new Error(
            'Retained plaintext edit has an original; explicit latest-version reconciliation is required',
          );
        missingPlaintextOriginals.set(sourceId, { source, proof });
      }
      const editedMessages = authoritativeMessages.filter((message) => {
        const classification = classifications.get(toChatwootSourceId((message.key as { id: string }).id));
        return (
          (message.status === 'EDITED' || editedIds.has(message.id)) &&
          (classification === 'ordinary' ||
            classification === 'unavailable_image_edit' ||
            classification === 'unavailable_text_edit' ||
            classification === 'unavailable_document_edit' ||
            classification === 'unavailable_audio_edit' ||
            classification === 'unavailable_other_edit')
        );
      });
      const encryptedEdits = authoritativeMessages.filter(
        (message) => classifications.get(toChatwootSourceId((message.key as { id: string }).id)) === 'encrypted_edit',
      );
      const readEncryptedEditState = async (envelope: MessageModel, target: MessageModel) => {
        const [sourceRows, targetUpdates, competitors] = await Promise.all([
          this.prismaRepository.message.findMany({
            where: { instanceId: envelope.instanceId, id: { in: [envelope.id, target.id] } },
          }),
          this.prismaRepository.messageUpdate.findMany({
            where: { instanceId: envelope.instanceId, messageId: target.id, status: 'EDITED' },
          }),
          this.prismaRepository.message.findMany({
            where: {
              instanceId: envelope.instanceId,
              id: { not: envelope.id },
              messageTimestamp: { gte: envelope.messageTimestamp },
              OR: [
                {
                  message: {
                    path: ['secretEncryptedMessage', 'targetMessageKey', 'id'],
                    equals: (target.key as any).id,
                  },
                },
                { message: { path: ['protocolMessage', 'key', 'id'], equals: (target.key as any).id } },
                {
                  message: {
                    path: ['editedMessage', 'message', 'protocolMessage', 'key', 'id'],
                    equals: (target.key as any).id,
                  },
                },
              ],
            },
          }),
        ]);
        const byId = (rows: any[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
        return { sourceRows: byId(sourceRows), targetUpdates: byId(targetUpdates), competitors: byId(competitors) };
      };
      const missingEncryptedOriginals = new Map<
        string,
        { source: MessageModel; proof: IgnoredMissingEncryptedOriginalProof }
      >();
      const encryptedTargets = new Map<string, MessageModel>();
      const encryptedStates = new Map<string, Awaited<ReturnType<typeof readEncryptedEditState>>>();
      const unavailableOriginalTargets = new Set<string>();
      const selectedEncryptedOriginals = new Set<string>();
      const existingSelectedEncryptedOriginals = new Set<string>();
      const unavailableOriginalEdits = new Map<
        string,
        {
          source: MessageModel;
          target: MessageModel;
          state: UnavailableOriginalEditState;
          proof: UnavailableOriginalEditProof;
        }
      >();

      const recoveredEdits: Array<{ envelope: MessageModel; target: MessageModel; recovered: MessageModel }> = [];
      const ignoredEdits = new Map<
        string,
        { envelope: MessageModel; target: MessageModel; kind: IgnoredHistoryEditKind; rejection: string }
      >();
      for (const message of authoritativeMessages) {
        const sourceId = toChatwootSourceId((message.key as { id: string }).id);
        if (classifications.get(sourceId) === 'conflicting_text_edit')
          ignoredEdits.set(sourceId, {
            envelope: message,
            target: message,
            kind: 'conflicting',
            rejection: CONFLICTING_TEXT_EDIT_REJECTION,
          });
      }
      for (const envelope of encryptedEdits) {
        const targetKey = (envelope.message as any).secretEncryptedMessage.targetMessageKey;
        const matches = await this.prismaRepository.message.findMany({
          where: { instanceId: envelope.instanceId, key: { path: ['id'], equals: targetKey.id } },
        });
        if (matches.length === 0) {
          const proof = await captureMissingEncryptedEditOriginal(
            envelope,
            this.prismaRepository.message,
            Number(provider.accountId),
            inbox.id,
          );
          if (!proof) throw new Error('Missing encrypted edit original appeared before qualification');
          missingEncryptedOriginals.set(proof.sourceId, { source: envelope, proof });
          continue;
        }
        if (matches.length !== 1) throw new Error('Retained encrypted edit original is ambiguous');
        const target = matches[0];
        assertIgnoredEditOriginalIdentity(envelope, target);
        const state = await readEncryptedEditState(envelope, target);
        if (
          state.sourceRows.length !== 2 ||
          !state.sourceRows.some((row) => isDeepStrictEqual(row, envelope)) ||
          !state.sourceRows.some((row) => isDeepStrictEqual(row, target))
        )
          throw new Error('Retained encrypted edit source or original rotated');
        const verified = await chatwootImport.getVerifiedRecoverySourceIds([target], inbox.id, provider);
        const targetSourceId = toChatwootSourceId((target.key as { id: string }).id);
        const selectedTarget = authoritativeMessages.filter((message) => message.id === target.id);
        const selectedAvailableOriginal =
          selectedTarget.length === 1 &&
          isDeepStrictEqual(selectedTarget[0], target) &&
          classifications.get(targetSourceId) === 'ordinary' &&
          target.chatwootMessageId == null &&
          target.chatwootInboxId == null &&
          target.chatwootConversationId == null;
        if (verified.has(targetSourceId) && selectedAvailableOriginal) {
          selectedEncryptedOriginals.add(target.id);
          existingSelectedEncryptedOriginals.add(target.id);
        }
        if (!verified.has(targetSourceId)) {
          if (!isUnavailableNullEditOriginal(target)) {
            if (!selectedAvailableOriginal)
              throw new Error('Retained encrypted edit requires an existing unique destination original');
            selectedEncryptedOriginals.add(target.id);
          } else {
            if (
              encryptedEdits.filter(
                (edit) => (edit.message as any).secretEncryptedMessage.targetMessageKey.id === (target.key as any).id,
              ).length !== 1
            )
              throw new Error('Unavailable encrypted edit original has competing requested edits');
            const proof = await chatwootImport.captureUnavailableOriginalEdit(
              envelope,
              target,
              state,
              inbox.id,
              provider,
            );
            unavailableOriginalEdits.set(proof.sourceId, { source: envelope, target, state, proof });
            unavailableOriginalTargets.add(target.id);
          }
        }
        encryptedTargets.set(envelope.id, target);
        encryptedStates.set(envelope.id, state);
      }
      const qualifiedEncryptedEdits = encryptedEdits.filter(
        (envelope) => !missingEncryptedOriginals.has(toChatwootSourceId((envelope.key as { id: string }).id)),
      );
      const assertEncryptedEditCurrent = async (envelope: MessageModel, target: MessageModel) => {
        if (!isDeepStrictEqual(await readEncryptedEditState(envelope, target), encryptedStates.get(envelope.id)))
          throw new Error('Retained encrypted edit source, ordering or current original rotated');
      };
      for (const envelope of qualifiedEncryptedEdits) {
        const target = encryptedTargets.get(envelope.id)!;
        const state = encryptedStates.get(envelope.id)!;
        if (unavailableOriginalTargets.has(target.id)) continue;
        const sameTarget = qualifiedEncryptedEdits.filter((edit) => encryptedTargets.get(edit.id)?.id === target.id);
        if (
          sameTarget.length > 1 ||
          state.targetUpdates.length ||
          state.competitors.length ||
          target.status === 'EDITED'
        ) {
          ignoredEdits.set(toChatwootSourceId((envelope.key as { id: string }).id), {
            envelope,
            target,
            kind: 'conflicting',
            rejection: 'retained_edit_order_conflict',
          });
          continue;
        }
        try {
          recoveredEdits.push({ envelope, target, recovered: recoverEncryptedHistoryEdit(envelope, target) });
        } catch (error) {
          const kind = ignoredHistoryEditFailure(error);
          if (!kind) throw error;
          ignoredEdits.set(toChatwootSourceId((envelope.key as { id: string }).id), {
            envelope,
            target,
            kind,
            rejection: (error as Error).message,
          });
        }
      }
      const albumParents = authoritativeMessages.filter(
        (message) => classifications.get(toChatwootSourceId((message.key as { id: string }).id)) === 'album_container',
      );
      const albumPreservation = await preserveAlbumContainers(
        albumParents,
        this.prismaRepository.message,
        postgresClient.getChatwootConnection(),
        Number(provider.accountId),
        inbox.id,
        'container_only',
      );
      const ordinaryMessages = authoritativeMessages.filter(
        (message) => classifications.get(toChatwootSourceId((message.key as { id: string }).id)) === 'ordinary',
      );
      await albumPreservation.assertCurrent();
      const preparedBySourceId = new Map(
        ordinaryMessages.map((message) => {
          const sourceId = toChatwootSourceId((message.key as { id: string }).id);
          const display = ['associatedChildMessage', 'ephemeralMessage'].includes(message.messageType)
            ? {
                ...message,
                messageType: retainedHistoryMedia(message).type,
                message: retainedHistoryDisplayBody(message),
              }
            : message;
          const prepared =
            data.recoveryMode === 'maximize' &&
            !['lottieStickerMessage', 'buttonsMessage'].includes(message.messageType)
              ? prepareStoredHistoryRecoveryMessage(display)
              : { message: display, recovery: 'native' as const, reason: 'standard_mode' };
          return [sourceId, prepared] as const;
        }),
      );
      const preparedMessages = ordinaryMessages.map((message) => {
        const sourceId = toChatwootSourceId((message.key as { id: string }).id);
        return preparedBySourceId.get(sourceId)?.message || message;
      });

      const lidMappingRefresh = data.refreshLidMappings
        ? await this.refreshKnownLidMappings(instance, authoritativeMessages)
        : { attemptedPhoneJids: 0, refreshedMappings: 0 };
      const normalized = await normalizeStoredHistoryMessages(
        preparedMessages,
        authoritativeMessages,
        (lid) => this.resolvePhoneJidForLid(instance, lid),
        {
          retainProviderAliases: this.configService.get<Chatwoot>('CHATWOOT').PROVIDER_CONVERSATION_BINDINGS,
          includeGroups: data.scope === 'groups' || data.scope === 'all',
          includeUnresolvedLids:
            data.unresolvedLidMode === 'provisional' && (data.scope === 'direct' || data.scope === 'all'),
        },
      );
      const normalizedSourceIds = new Set(
        normalized.messages.map((message) => toChatwootSourceId((message.key as { id: string }).id)),
      );
      const scopedMessages = normalized.messages.filter((message: any) => {
        const remoteJid = message.key?.remoteJid;
        if (data.scope === 'groups') return isGroupJid(remoteJid);
        if (data.scope === 'direct') return !isGroupJid(remoteJid);
        return true;
      });
      const scopedSourceIds = new Set(
        scopedMessages.map((message) => toChatwootSourceId((message.key as { id: string }).id)),
      );
      const { messages: uniqueMessages, duplicateMessages: duplicateSourceMessagesSkipped } =
        dedupeHistoryMessagesBySourceId(scopedMessages);
      const normalizedPeerBySource = new Map(
        normalized.messages.map((message) => [
          toChatwootSourceId((message.key as { id: string }).id),
          (message.key as { remoteJid: string }).remoteJid,
        ]),
      );
      const taggedAuthorityMessages = [...authoritativeMessages, ...encryptedTargets.values()].map((message) => ({
        ...message,
        key: {
          ...(message.key as any),
          remoteJid:
            normalizedPeerBySource.get(toChatwootSourceId((message.key as { id: string }).id)) ||
            (message.key as any).remoteJid,
        },
      }));
      const taggedMediaSourceIds = await this.assertTaggedHistoryMediaStored(
        taggedAuthorityMessages,
        instance,
        provider,
        inbox.id,
      );
      const existingSourceIds = await chatwootImport.getVerifiedRecoverySourceIds(
        authoritativeMessages,
        inbox.id,
        provider,
      );
      const readUnavailableOriginalState = async (target: MessageModel): Promise<UnavailableOriginalEditState> => {
        const [current, updates] = await Promise.all([
          this.prismaRepository.message.findUnique({ where: { id: target.id } }),
          this.prismaRepository.messageUpdate.findMany({
            where: { instanceId: target.instanceId, messageId: target.id, status: 'EDITED' },
          }),
        ]);
        if (!isDeepStrictEqual(current, target)) throw new Error('Unavailable edit original native source rotated');
        return {
          sourceRows: [current],
          targetUpdates: updates.sort((a, b) => a.id.localeCompare(b.id)),
          competitors: [],
        };
      };
      // Preserve the previously proven unavailable encrypted original dependencies.
      for (const target of editedMessages.filter((row) => unavailableOriginalTargets.has(row.id))) {
        const state = await readUnavailableOriginalState(target);
        const proof = await chatwootImport.captureUnavailableOriginalEdit(target, target, state, inbox.id, provider);
        unavailableOriginalEdits.set(proof.sourceId, { source: target, target, state, proof });
      }
      const ignoredNullEdits = new Map<
        string,
        { source: MessageModel; state: UnavailableOriginalEditState; proof: IgnoredNullEditProof }
      >();
      const initiallyMissing = uniqueMessages.filter(
        (message: any) => !existingSourceIds.has(toChatwootSourceId(message.key.id)),
      );
      const cachedMedia = await prepareCachedRecoveryMedia(
        initiallyMissing.map((message) => storedById.get(message.id)!),
        (message) =>
          this.prismaRepository.media.findFirst({ where: { messageId: message.id, instanceId: message.instanceId } }),
        (name, limit, mime) => this.readCachedRecoveryObject(name, limit, mime),
        (message) => this.readRecoveryMedia(message, provider),
      );
      if (cachedMedia.size) {
        const config = this.configService.get<Chatwoot>('CHATWOOT');
        if (!config.PROVIDER_CONVERSATION_BINDINGS || !config.NATIVE_BRIDGE_TOKEN)
          throw new Error('cached_media_silent_import_unavailable');
        await this.assertSilentHistoryMediaCapability(instance, provider, inbox.id);
      }
      const currentWholeSource = await this.prismaRepository.message.findMany({
        where: { Instance: { name: instance.instanceName }, id: { in: Array.from(requestedDatabaseIds) } },
      });
      if (
        currentWholeSource.length !== authoritativeMessages.length ||
        currentWholeSource.some((row) => !isDeepStrictEqual(row, storedById.get(row.id)))
      )
        throw new Error('cached_media_whole_source_rotated_before_import');
      await chatwootImport.activateHistorySourceGuards(
        Array.from(
          new Set([
            ...requestedSourceIds,
            ...Array.from(encryptedTargets.values()).map((target) =>
              toChatwootSourceId((target.key as { id: string }).id),
            ),
          ]),
        ).filter((id) => !albumPreservation.proofs.has(id)),
        inbox.id,
      );
      const outboundBridgeSourceIds = await chatwootImport.reconcileOutboundHistoryBindings(
        authoritativeMessages,
        inbox.id,
      );
      for (const sourceId of outboundBridgeSourceIds) existingSourceIds.add(sourceId);
      const missingMessages = uniqueMessages.filter(
        (message: any) => !existingSourceIds.has(toChatwootSourceId(message.key.id)),
      );
      // Retained edits are updates, even when the original source already exists.
      // Confirm them before acknowledging this batch so the ordinary worker can retry failures.
      const editedSourceIds = new Set(
        editedMessages.map((message) => toChatwootSourceId((message.key as { id: string }).id)),
      );
      for (const { envelope, target, recovered } of recoveredEdits.filter(
        ({ target }) => !selectedEncryptedOriginals.has(target.id),
      )) {
        await assertEncryptedEditCurrent(envelope, target);
        try {
          await chatwootImport.reconcileProviderHistoryEdits([recovered], inbox.id, provider, this, true);
        } catch (error) {
          // This exact rejection occurs before applyWhatsappProviderEdit. Unknown write outcomes still stop.
          if (
            !(error instanceof Error) ||
            error.message !== 'Authenticated provider edit cannot replace a different existing edit'
          )
            throw error;
          ignoredEdits.set(toChatwootSourceId((envelope.key as { id: string }).id), {
            envelope,
            target,
            kind: 'conflicting',
            rejection: error.message,
          });
        }
      }
      const preservedEdits = await chatwootImport.reconcileProviderHistoryEdits(
        editedMessages.filter(
          (message) => !unavailableOriginalEdits.has(toChatwootSourceId((message.key as { id: string }).id)),
        ),
        inbox.id,
        provider,
        this,
        false,
        undefined,
        async (source) => {
          const state = await readUnavailableOriginalState(source);
          const proof = ignoredNullEditProof(source, state, Number(provider.accountId), inbox.id);
          ignoredNullEdits.set(proof.sourceId, { source, state, proof });
        },
      );
      const importableMessages = missingMessages.filter(
        (message: any) =>
          !cachedMedia.has(message.id) && Boolean(chatwootImport.getContentMessage(this, message, true)),
      );
      const importableSourceIds = new Set(
        importableMessages.map((message) => toChatwootSourceId((message.key as { id: string }).id)),
      );

      let importedMessages = 0;
      let appliedMessages = 0;
      let appliedSourceIds = new Set<string>();
      if (importableMessages.length > 0) {
        const identityNames = await this.getGroupIdentityNames(instance, importableMessages);
        const imported = await chatwootImport.importHistoryMessages(instance, this, inbox, provider, {
          messages: importableMessages,
          identityNames,
        });
        if (!Number.isInteger(imported)) {
          throw new Error(`Chatwoot recovery import failed for ${instance.instanceName}`);
        }
        importedMessages = Number(imported);
        appliedSourceIds = await chatwootImport.getVerifiedRecoverySourceIds(importableMessages, inbox.id, provider);
        if (appliedSourceIds.size !== importableMessages.length) {
          throw new Error(
            `Chatwoot recovery only applied ${appliedSourceIds.size}/${importableMessages.length} messages for ${instance.instanceName}`,
          );
        }
        appliedMessages = appliedSourceIds.size;
        await this.waMonitor.waInstances[instance.instanceName]?.clearCacheChatwoot?.();
      }

      for (const message of missingMessages) {
        const cached = cachedMedia.get(message.id);
        if (!cached) continue;
        const sourceId = toChatwootSourceId((message.key as { id: string }).id);
        if ((await chatwootImport.getVerifiedRecoverySourceIds([message], inbox.id, provider)).has(sourceId))
          throw new Error('cached_media_destination_rotated_before_import');
        const current = await this.prismaRepository.message.findUnique({ where: { id: message.id } });
        const original = storedById.get(message.id);
        const currentMedia = await this.prismaRepository.media.findFirst({
          where: { messageId: message.id, instanceId: message.instanceId },
        });
        if (!isDeepStrictEqual(current, original) || !isDeepStrictEqual(currentMedia, cached.media))
          throw new Error('cached_media_source_rotated_before_import');
        const mapped = chatwootImport.createMessagesMapByIdentity([message]);
        const peer = [...mapped.keys()][0];
        const fks = await chatwootImport.selectOrCreateFksFromChatwoot(
          provider,
          inbox,
          new Map([[peer, { first: message.messageTimestamp, last: message.messageTimestamp }]]),
          mapped,
          await this.getGroupIdentityNames(instance, [message]),
        );
        const conversationId = Number(fks.get(peer)?.conversation_id);
        if (!Number.isSafeInteger(conversationId) || conversationId < 1)
          throw new Error('cached_media_canonical_destination_unavailable');
        const canonical = await postgresClient.getChatwootConnection().query(
          `SELECT c.id, c.display_id FROM conversations c JOIN provider_conversation_bindings b
           ON b.conversation_id=c.id AND b.account_id=c.account_id AND b.inbox_id=c.inbox_id
           WHERE c.id=$1 AND c.account_id=$2 AND c.inbox_id=$3 AND b.provider='whatsapp' AND b.peer=$4`,
          [conversationId, Number(provider.accountId), inbox.id, peer],
        );
        const displayId = Number(canonical.rows[0]?.display_id);
        if (canonical.rows.length !== 1 || !Number.isSafeInteger(displayId) || displayId < 1)
          throw new Error('cached_media_canonical_destination_unavailable');
        const content =
          message.messageType === 'templateMessage'
            ? retainedTemplate(message.message).text
            : this.getConversationMessage(message.message);
        const uploaded = await this.sendData(
          displayId,
          Readable.from(cached.bytes),
          cached.descriptor.filename,
          (message.key as { fromMe: boolean }).fromMe ? 'outgoing' : 'incoming',
          content,
          instance,
          message,
          sourceId,
          undefined,
          provider,
          false,
          {
            inboxId: inbox.id,
            timestamp: message.messageTimestamp,
            peer,
            mimetype: cached.descriptor.mimetype,
            size: cached.descriptor.size,
            sha256: cached.descriptor.digest.toString('hex'),
            mediaType: cachedHistoryMediaType(original),
            ...([
              'associatedChildMessage',
              'templateMessage',
              'lottieStickerMessage',
              'ephemeralMessage',
              'stickerMessage',
            ].includes(original.messageType)
              ? {
                  nativeSource: {
                    message_type: original.messageType,
                    sha256: createHash('sha256').update(JSON.stringify(original)).digest('hex'),
                  },
                }
              : {}),
          },
        );
        await this.verifyRecoveryMediaDestination(message, provider, inbox.id, cached.descriptor, cached.bytes, {
          conversationId,
          displayId,
          content,
          attributes: uploaded.expectedContentAttributes,
        });
        await this.assertTaggedHistoryMediaStored([message], instance, provider, inbox.id, new Set([sourceId]));
        taggedMediaSourceIds.add(sourceId);
        appliedSourceIds.add(sourceId);
        importableSourceIds.add(sourceId);
        importedMessages++;
        appliedMessages++;
      }

      const importedEditOriginals = new Map<
        string,
        Awaited<ReturnType<typeof chatwootImport.verifyImportedHistoryEditOriginal>>
      >();
      for (const envelope of qualifiedEncryptedEdits) {
        const target = encryptedTargets.get(envelope.id)!;
        if (!selectedEncryptedOriginals.has(target.id)) continue;
        await assertEncryptedEditCurrent(envelope, target);
        const sourceId = toChatwootSourceId((target.key as { id: string }).id);
        const newlyImported = appliedSourceIds.has(sourceId) && importableSourceIds.has(sourceId);
        const verifiedPreviousImport =
          existingSelectedEncryptedOriginals.has(target.id) &&
          existingSourceIds.has(sourceId) &&
          (![
            'imageMessage',
            'audioMessage',
            'videoMessage',
            'documentMessage',
            'associatedChildMessage',
            'templateMessage',
          ].includes(target.messageType) ||
            taggedMediaSourceIds.has(sourceId));
        if (!newlyImported && !verifiedPreviousImport)
          throw new Error('Retained encrypted edit original was not imported and verified in this batch');
        const verified = await chatwootImport.getVerifiedRecoverySourceIds([target], inbox.id, provider);
        if (!verified.has(sourceId))
          throw new Error('Retained encrypted edit requires an existing unique destination original');
        importedEditOriginals.set(
          target.id,
          await chatwootImport.verifyImportedHistoryEditOriginal(target, inbox.id, provider),
        );
      }
      for (const { envelope, target, recovered } of recoveredEdits.filter(({ target }) =>
        selectedEncryptedOriginals.has(target.id),
      )) {
        await assertEncryptedEditCurrent(envelope, target);
        try {
          await chatwootImport.reconcileProviderHistoryEdits([recovered], inbox.id, provider, this, true, {
            ...importedEditOriginals.get(target.id)!,
            recoveredVersionSHA256: createHash('sha256').update(JSON.stringify(recovered)).digest('hex'),
          });
        } catch (error) {
          // This exact rejection occurs before applyWhatsappProviderEdit. Unknown write outcomes still stop.
          if (
            !(error instanceof Error) ||
            error.message !== 'Authenticated provider edit cannot replace a different existing edit'
          )
            throw error;
          ignoredEdits.set(toChatwootSourceId((envelope.key as { id: string }).id), {
            envelope,
            target,
            kind: 'conflicting',
            rejection: error.message,
          });
        }
      }
      await chatwootImport.reconcileProviderHistoryEdits(
        editedMessages.filter((message) =>
          appliedSourceIds.has(toChatwootSourceId((message.key as { id: string }).id)),
        ),
        inbox.id,
        provider,
        this,
      );

      const ignoredEditProofs = new Map();
      for (const envelope of qualifiedEncryptedEdits) {
        const target = encryptedTargets.get(envelope.id)!;
        await assertEncryptedEditCurrent(envelope, target);
        const ignored = ignoredEdits.get(toChatwootSourceId((envelope.key as { id: string }).id));
        if (ignored)
          ignoredEditProofs.set(
            toChatwootSourceId((envelope.key as { id: string }).id),
            await chatwootImport.captureIgnoredHistoryEdit(
              envelope,
              target,
              inbox.id,
              provider,
              ignored.kind,
              ignored.rejection,
              importedEditOriginals.get(target.id),
            ),
          );
      }
      for (const [sourceId, ignored] of ignoredEdits) {
        if (classifications.get(sourceId) === 'conflicting_text_edit') {
          const current = await this.prismaRepository.message.findUnique({ where: { id: ignored.envelope.id } });
          if (!isDeepStrictEqual(current, ignored.envelope))
            throw new Error('Ignored provider edit native source rotated');
          ignoredEditProofs.set(
            sourceId,
            await chatwootImport.captureIgnoredHistoryEdit(
              ignored.envelope,
              ignored.target,
              inbox.id,
              provider,
              ignored.kind,
              ignored.rejection,
            ),
          );
        }
      }
      for (const envelope of qualifiedEncryptedEdits)
        await assertEncryptedEditCurrent(envelope, encryptedTargets.get(envelope.id)!);
      await albumPreservation.assertCurrent();
      for (const [sourceId, ignored] of ignoredEdits) {
        if (classifications.get(sourceId) === 'conflicting_text_edit') {
          const source = await this.prismaRepository.message.findUnique({ where: { id: ignored.envelope.id } });
          if (!isDeepStrictEqual(source, ignored.envelope))
            throw new Error('Ignored provider edit native source rotated');
        }
        const current = await chatwootImport.captureIgnoredHistoryEdit(
          ignored.envelope,
          ignored.target,
          inbox.id,
          provider,
          ignored.kind,
          ignored.rejection,
          importedEditOriginals.get(ignored.target.id),
        );
        if (!isDeepStrictEqual(current, ignoredEditProofs.get(sourceId)))
          throw new Error('Ignored provider edit destination or media rotated before acknowledgement');
      }
      for (const envelope of qualifiedEncryptedEdits)
        await assertEncryptedEditCurrent(envelope, encryptedTargets.get(envelope.id)!);
      for (const [id, cached] of cachedMedia) {
        const current = await this.prismaRepository.message.findUnique({ where: { id } });
        const media = await this.prismaRepository.media.findFirst({
          where: { messageId: id, instanceId: current?.instanceId },
        });
        if (!isDeepStrictEqual(current, storedById.get(id)) || !isDeepStrictEqual(media, cached.media))
          throw new Error('cached_media_source_rotated_before_acknowledgement');
      }
      await this.assertTaggedHistoryMediaStored(
        taggedAuthorityMessages,
        instance,
        provider,
        inbox.id,
        taggedMediaSourceIds,
      );
      for (const [sourceId, unavailable] of unavailableOriginalEdits) {
        const state =
          unavailable.source.id === unavailable.target.id
            ? await readUnavailableOriginalState(unavailable.target)
            : await readEncryptedEditState(unavailable.source, unavailable.target);
        if (!isDeepStrictEqual(state, unavailable.state))
          throw new Error('Unavailable edit original ordering or source rotated before acknowledgement');
        const proof = await chatwootImport.captureUnavailableOriginalEdit(
          unavailable.source,
          unavailable.target,
          state,
          inbox.id,
          provider,
        );
        if (!isDeepStrictEqual(proof, unavailable.proof) || proof.sourceId !== sourceId)
          throw new Error('Unavailable edit original dependency proof rotated before acknowledgement');
      }
      for (const ignored of ignoredNullEdits.values()) {
        const state = await readUnavailableOriginalState(ignored.source);
        const proof = ignoredNullEditProof(ignored.source, state, Number(provider.accountId), inbox.id);
        if (!isDeepStrictEqual(state, ignored.state) || !isDeepStrictEqual(proof, ignored.proof))
          throw new Error('Ignored NULL edit source or provenance rotated before acknowledgement');
      }
      for (const missing of missingEncryptedOriginals.values()) {
        const proof = await captureMissingEncryptedEditOriginal(
          missing.source,
          this.prismaRepository.message,
          Number(provider.accountId),
          inbox.id,
        );
        if (!isDeepStrictEqual(proof, missing.proof))
          throw new Error('Missing encrypted edit original or source rotated before acknowledgement');
      }
      for (const missing of missingPlaintextOriginals.values()) {
        const proof = await captureMissingPlaintextEditOriginal(
          missing.source,
          this.prismaRepository.message,
          Number(provider.accountId),
          inbox.id,
        );
        if (!isDeepStrictEqual(proof, missing.proof))
          throw new Error('Missing plaintext edit original or source rotated before acknowledgement');
      }
      const outcomes = Array.from(requestedSourceIds).map((sourceId) => {
        const missingPlaintextOriginal = missingPlaintextOriginals.get(sourceId)?.proof;
        if (missingPlaintextOriginal)
          return {
            sourceId,
            status: 'skipped',
            reason: UNAVAILABLE_ORIGINAL_EDIT_REASON,
            recovery: 'unsupported',
            unavailableOriginalEdit: missingPlaintextOriginal,
          };
        const missingEncryptedOriginal = missingEncryptedOriginals.get(sourceId)?.proof;
        if (missingEncryptedOriginal)
          return {
            sourceId,
            status: 'skipped',
            reason: UNAVAILABLE_ORIGINAL_EDIT_REASON,
            recovery: 'unsupported',
            unavailableOriginalEdit: missingEncryptedOriginal,
          };
        const ignoredNullEdit = ignoredNullEdits.get(sourceId)?.proof;
        if (ignoredNullEdit)
          return {
            sourceId,
            status: 'skipped',
            reason: UNAVAILABLE_ORIGINAL_EDIT_REASON,
            recovery: 'unsupported',
            unavailableOriginalEdit: ignoredNullEdit,
          };
        const preparation = preparedBySourceId.get(sourceId);
        const classification = classifications.get(sourceId);
        const unavailableOriginalEdit = unavailableOriginalEdits.get(sourceId)?.proof;
        if (unavailableOriginalEdit)
          return {
            sourceId,
            status: 'skipped',
            reason: UNAVAILABLE_ORIGINAL_EDIT_REASON,
            recovery: 'unsupported',
            unavailableOriginalEdit,
          };
        if (classification === 'album_container')
          return {
            sourceId,
            status: 'skipped',
            reason: 'preserved_unsupported_album_container',
            recovery: 'unsupported',
            albumPreservation: albumPreservation.proofs.get(sourceId),
          };
        if (classification === 'encrypted_edit' || classification === 'conflicting_text_edit') {
          const ignoredEditPreservation = ignoredEditProofs.get(sourceId);
          if (ignoredEditPreservation)
            return {
              sourceId,
              status: 'skipped',
              reason: IGNORED_HISTORY_EDIT_REASON,
              recovery: 'unsupported',
              ignoredEditPreservation,
            };
          return { sourceId, status: 'existing', reason: 'authenticated_provider_edit_reconciled', recovery: 'native' };
        }
        if (classification === 'pin_control' || classification === 'poll_control')
          return {
            sourceId,
            status: 'skipped',
            reason: `preserved_unsupported_${classification}`,
            recovery: 'unsupported',
          };
        if (
          classification === 'reaction_control' ||
          classification === 'encryption_control' ||
          classification === 'metadata_control'
        ) {
          return { sourceId, status: 'skipped', reason: `known_${classification}`, recovery: 'unsupported' };
        }
        if (preservedEdits.has(sourceId)) {
          return { sourceId, status: 'existing', reason: preservedEdits.get(sourceId), recovery: 'native' };
        }
        if (existingSourceIds.has(sourceId)) {
          return {
            sourceId,
            status: 'existing',
            reason: editedSourceIds.has(sourceId) ? 'provider_edit_reconciled' : 'already_in_destination',
            recovery: preparation?.recovery,
          };
        }
        if (appliedSourceIds.has(sourceId)) {
          return {
            sourceId,
            status: 'imported',
            reason: editedSourceIds.has(sourceId) ? 'provider_edit_reconciled' : preparation?.reason || 'native',
            recovery: preparation?.recovery,
          };
        }
        const reason = !normalizedSourceIds.has(sourceId)
          ? 'normalization_filtered'
          : !scopedSourceIds.has(sourceId)
            ? 'scope_filtered'
            : !importableSourceIds.has(sourceId)
              ? 'unsupported_content'
              : 'not_applied';
        if (reason === 'not_applied') {
          throw new Error(`Chatwoot recovery outcome is ambiguous for ${sourceId}`);
        }
        return { sourceId, status: 'skipped', reason, recovery: preparation?.recovery };
      });
      const skippedMessages = outcomes.filter((outcome) => outcome.status === 'skipped').length;
      const placeholderMessages = outcomes.filter(
        (outcome) => outcome.status === 'imported' && outcome.recovery === 'placeholder',
      ).length;

      // Complete dependency recaptures before changing native pointer-only metadata.
      // Skipped edits and controls do not represent a destination message to bind.
      const nativeBindings = [];
      for (const row of authoritativeMessages) {
        if (!this.configService.get<Chatwoot>('CHATWOOT').PROVIDER_CONVERSATION_BINDINGS) break;
        const sourceId = toChatwootSourceId((row.key as { id: string }).id);
        if (
          classifications.get(sourceId) !== 'ordinary' ||
          !outcomes.some(
            (outcome) => outcome.sourceId === sourceId && ['existing', 'imported'].includes(outcome.status),
          )
        )
          continue;
        nativeBindings.push(
          await reconcileHistoryMessageBinding(
            postgresClient.getChatwootConnection(),
            this.prismaRepository,
            row,
            Number(provider.accountId),
            inbox.id,
            false,
          ),
        );
      }

      if (data.scope === 'all' && data.unresolvedLidMode === 'provisional') {
        await this.enableExtendedHistorySync(instance);
      }

      return {
        contractVersion: '2026-08-28',
        status: 'completed',
        instanceName: instance.instanceName,
        ...destination,
        providerEnabled: Boolean(provider.enabled),
        scope: data.scope,
        unresolvedLidMode: data.unresolvedLidMode,
        recoveryMode: data.recoveryMode,
        attemptedPhoneJids: lidMappingRefresh.attemptedPhoneJids,
        refreshedLidMappings: lidMappingRefresh.refreshedMappings,
        sourceMessages: data.messages.length,
        existingMessages: outcomes.filter((outcome) => outcome.status === 'existing').length,
        selectedMessages: data.messages.length,
        importedMessages,
        appliedMessages,
        skippedMessages,
        placeholderMessages,
        duplicateSourceMessagesSkipped,
        processedSourceIds: Array.from(requestedSourceIds),
        nativeBindings,
        outcomes,
      };
    } finally {
      releaseWriter();
    }
  }

  private async incrementalHistorySince(instance: InstanceDto) {
    const checkpoint = await this.cache.hGet(this.historySyncCheckpointKey, instance.instanceName);
    const parsedCheckpoint = checkpoint ? dayjs(checkpoint) : null;
    return parsedCheckpoint?.isValid()
      ? parsedCheckpoint.subtract(15, 'minutes').toISOString()
      : dayjs().subtract(6, 'hours').toISOString();
  }

  public async syncLostMessages(instance: InstanceDto, requestedSince?: string) {
    try {
      if (!this.configService.get<Database>('DATABASE').SAVE_DATA.MESSAGE_UPDATE) {
        return;
      }

      const extendedHistorySync = await this.isExtendedHistorySyncEnabled(instance);
      const since = requestedSince || (await this.incrementalHistorySince(instance));
      await enqueueIncrementalHistorySync(instance.instanceName, since, async (coalescedSince) => {
        await this.syncStoredHistory(instance, {
          dryRun: false,
          since: coalescedSince,
          scope: extendedHistorySync ? 'all' : 'direct',
          unresolvedLidMode: extendedHistorySync ? 'provisional' : 'skip',
        });
        await this.cache.hSet(this.historySyncCheckpointKey, instance.instanceName, dayjs().toISOString());
      });
    } catch (error) {
      this.logger.error(`Error on incremental Chatwoot history sync: ${formatCaughtError(error)}`);
      return;
    }
  }
}
