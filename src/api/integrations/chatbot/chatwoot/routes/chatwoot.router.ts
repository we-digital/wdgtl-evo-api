import { RouterBroker } from '@api/abstract/abstract.router';
import { InstanceDto } from '@api/dto/instance.dto';
import {
  ChatwootDto,
  ChatwootHistoryRecoveryBatchDto,
  ChatwootHistorySyncBatchDto,
  ChatwootHistorySyncDto,
} from '@api/integrations/chatbot/chatwoot/dto/chatwoot.dto';
import { HttpStatus } from '@api/routes/index.router';
import { chatwootController } from '@api/server.module';
import {
  chatwootHistoryRecoveryBatchSchema,
  chatwootHistorySyncBatchSchema,
  chatwootHistorySyncSchema,
  chatwootSchema,
  instanceSchema,
} from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';

export class ChatwootRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      .post(this.routerPath('set'), ...guards, async (req, res) => {
        const response = await this.dataValidate<ChatwootDto>({
          request: req,
          schema: chatwootSchema,
          ClassRef: ChatwootDto,
          execute: (instance, data) => chatwootController.createChatwoot(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .get(this.routerPath('find'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => chatwootController.findChatwoot(instance),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('historySync'), ...guards, async (req, res) => {
        const response = await this.dataValidate<ChatwootHistorySyncDto>({
          request: req,
          schema: chatwootHistorySyncSchema,
          ClassRef: ChatwootHistorySyncDto,
          execute: (instance, data) => chatwootController.syncHistory(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('historySyncBatch/v1'), ...guards, async (req, res) => {
        const response = await this.dataValidate<ChatwootHistorySyncBatchDto>({
          request: req,
          schema: chatwootHistorySyncBatchSchema,
          ClassRef: ChatwootHistorySyncBatchDto,
          execute: (instance, data) => chatwootController.syncHistoryBatch(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .get(this.routerPath('historySyncBatch/v1'), ...guards, async (_req, res) => {
        res.status(HttpStatus.OK).json({
          contractVersion: '2026-08-01',
          maxBatchSize: 500,
          operation: 'bounded-cached-apply',
        });
      })
      .post(this.routerPath('historySyncBatch/v2'), ...guards, async (req, res) => {
        const response = await this.dataValidate<ChatwootHistoryRecoveryBatchDto>({
          request: req,
          schema: chatwootHistoryRecoveryBatchSchema,
          ClassRef: ChatwootHistoryRecoveryBatchDto,
          execute: (instance, data) => chatwootController.syncHistoryRecoveryBatch(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .get(this.routerPath('historySyncBatch/v2'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => chatwootController.historyRecoveryCapability(instance),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('webhook'), async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance, data) => chatwootController.receiveWebhook(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      });
  }

  public readonly router: Router = Router();
}
