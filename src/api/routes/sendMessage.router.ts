import { RouterBroker } from '@api/abstract/abstract.router';
import {
  SendAudioDto,
  SendButtonsDto,
  SendContactDto,
  SendListDto,
  SendLocationDto,
  SendMediaDto,
  SendPollDto,
  SendPtvDto,
  SendReactionDto,
  SendStatusDto,
  SendStickerDto,
  SendTemplateDto,
  SendTextDto,
} from '@api/dto/sendMessage.dto';
import { apiOutboundOperations, prismaRepository, sendMessageController } from '@api/server.module';
import { isApiOperationId } from '@api/services/api-outbound-operation';
import { resolveOutboundRequestId } from '@api/types/outbound-provenance';
import {
  audioMessageSchema,
  buttonsMessageSchema,
  contactMessageSchema,
  listMessageSchema,
  locationMessageSchema,
  mediaMessageSchema,
  pollMessageSchema,
  ptvMessageSchema,
  reactionMessageSchema,
  statusMessageSchema,
  stickerMessageSchema,
  templateMessageSchema,
  textMessageSchema,
} from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';
import multer from 'multer';

import { HttpStatus } from './index.router';

const upload = multer({ storage: multer.memoryStorage() });

export class MessageRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      .get('/operations/:instanceName/:operationId', ...guards, async (req, res) => {
        if (!isApiOperationId(req.params.operationId))
          return res.status(400).json({ error: 'INVALID_API_OPERATION_ID' });
        const instance = await prismaRepository.instance.findUnique({ where: { name: req.params.instanceName } });
        const result = await apiOutboundOperations.status(req.params.operationId, instance.id);
        return res.status(result ? 200 : 404).json(result || { error: 'API_OPERATION_NOT_FOUND' });
      })
      .post(this.routerPath('sendTemplate'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendTemplateDto>({
          request: req,
          schema: templateMessageSchema,
          ClassRef: SendTemplateDto,
          execute: (instance, data) => sendMessageController.sendTemplate(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendText'), ...guards, async (req, res) => {
        const requestId = resolveOutboundRequestId(req.get('x-request-id'));
        const response = await this.dataValidate<SendTextDto>({
          request: req,
          schema: textMessageSchema,
          ClassRef: SendTextDto,
          execute: async (instance, data) => {
            const key = req.get('idempotency-key');
            if (!key) return sendMessageController.sendText(instance, data, { version: 1, origin: 'api', requestId });
            if (!isApiOperationId(key)) throw { status: 400, message: ['INVALID_API_OPERATION_ID'] };
            const stored = await prismaRepository.instance.findUnique({ where: { name: instance.instanceName } });
            if (stored?.integration !== 'WHATSAPP-BAILEYS')
              throw { status: 400, message: ['API_OPERATION_REQUIRES_BAILEYS'] };
            return apiOutboundOperations.send(
              key,
              stored.id,
              'sendText',
              req.body,
              req.get('x-evo-retry-ambiguous') === 'true',
              (hooks) =>
                sendMessageController.sendText(instance, Object.assign(data, hooks), {
                  version: 1,
                  origin: 'api',
                  requestId: key,
                }),
            );
          },
        });

        return res
          .status(response?.operation && response.operation.state !== 'sent' ? HttpStatus.ACCEPTED : HttpStatus.CREATED)
          .json(response);
      })
      .post(this.routerPath('sendMedia'), ...guards, upload.single('file'), async (req, res) => {
        const bodyData = req.body;

        const response = await this.dataValidate<SendMediaDto>({
          request: req,
          schema: mediaMessageSchema,
          ClassRef: SendMediaDto,
          execute: async (instance) => {
            const key = req.get('idempotency-key');
            if (!key) return sendMessageController.sendMedia(instance, bodyData, req.file as any);
            if (!isApiOperationId(key) || req.file)
              throw { status: 400, message: ['API_OPERATION_REQUIRES_JSON_MEDIA'] };
            const stored = await prismaRepository.instance.findUnique({ where: { name: instance.instanceName } });
            if (stored?.integration !== 'WHATSAPP-BAILEYS')
              throw { status: 400, message: ['API_OPERATION_REQUIRES_BAILEYS'] };
            const payload = { ...bodyData };
            return apiOutboundOperations.send(
              key,
              stored.id,
              'sendMedia',
              payload,
              req.get('x-evo-retry-ambiguous') === 'true',
              (hooks) => sendMessageController.sendMedia(instance, Object.assign({ ...bodyData }, hooks)),
            );
          },
        });

        return res
          .status(response?.operation && response.operation.state !== 'sent' ? HttpStatus.ACCEPTED : HttpStatus.CREATED)
          .json(response);
      })
      .post(this.routerPath('sendPtv'), ...guards, upload.single('file'), async (req, res) => {
        const bodyData = req.body;

        const response = await this.dataValidate<SendPtvDto>({
          request: req,
          schema: ptvMessageSchema,
          ClassRef: SendPtvDto,
          execute: (instance) => sendMessageController.sendPtv(instance, bodyData, req.file as any),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendWhatsAppAudio'), ...guards, upload.single('file'), async (req, res) => {
        const bodyData = req.body;

        const response = await this.dataValidate<SendAudioDto>({
          request: req,
          schema: audioMessageSchema,
          ClassRef: SendMediaDto,
          execute: (instance) => sendMessageController.sendWhatsAppAudio(instance, bodyData, req.file as any),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      // TODO: Revisar funcionamento do envio de Status
      .post(this.routerPath('sendStatus'), ...guards, upload.single('file'), async (req, res) => {
        const bodyData = req.body;

        const response = await this.dataValidate<SendStatusDto>({
          request: req,
          schema: statusMessageSchema,
          ClassRef: SendStatusDto,
          execute: (instance) => sendMessageController.sendStatus(instance, bodyData, req.file as any),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendSticker'), ...guards, upload.single('file'), async (req, res) => {
        const bodyData = req.body;

        const response = await this.dataValidate<SendStickerDto>({
          request: req,
          schema: stickerMessageSchema,
          ClassRef: SendStickerDto,
          execute: (instance) => sendMessageController.sendSticker(instance, bodyData, req.file as any),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendLocation'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendLocationDto>({
          request: req,
          schema: locationMessageSchema,
          ClassRef: SendLocationDto,
          execute: (instance, data) => sendMessageController.sendLocation(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendContact'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendContactDto>({
          request: req,
          schema: contactMessageSchema,
          ClassRef: SendContactDto,
          execute: (instance, data) => sendMessageController.sendContact(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendReaction'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendReactionDto>({
          request: req,
          schema: reactionMessageSchema,
          ClassRef: SendReactionDto,
          execute: (instance, data) => sendMessageController.sendReaction(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendPoll'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendPollDto>({
          request: req,
          schema: pollMessageSchema,
          ClassRef: SendPollDto,
          execute: (instance, data) => sendMessageController.sendPoll(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendList'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendListDto>({
          request: req,
          schema: listMessageSchema,
          ClassRef: SendListDto,
          execute: (instance, data) => sendMessageController.sendList(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendButtons'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendButtonsDto>({
          request: req,
          schema: buttonsMessageSchema,
          ClassRef: SendButtonsDto,
          execute: (instance, data) => sendMessageController.sendButtons(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      });
  }

  public readonly router: Router = Router();
}
