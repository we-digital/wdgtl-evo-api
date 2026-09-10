-- CreateIndex
CREATE INDEX `Cwo_instance_planned_waid_idx`
ON `ChatwootOutboundOperation`(`instanceId`, `plannedWhatsappMessageId`);

-- CreateIndex
CREATE INDEX `Cwo_instance_actual_waid_idx`
ON `ChatwootOutboundOperation`(`instanceId`, `whatsappMessageId`);
