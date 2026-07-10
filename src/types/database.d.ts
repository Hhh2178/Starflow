// @db-hash e93b9eba8b6855913f31ab025855436b
//该文件由脚本自动生成，请勿手动修改

export interface memories {
  'content': string;
  'createTime': number;
  'embedding'?: string | null;
  'id'?: string;
  'isolationKey': string;
  'name'?: string | null;
  'relatedMessageIds'?: string | null;
  'role'?: string | null;
  'summarized'?: number | null;
  'type': string;
}
export interface o_agentDeploy {
  'desc'?: string | null;
  'disabled'?: boolean | null;
  'id'?: number;
  'key'?: string | null;
  'maxOutputTokens'?: number | null;
  'model'?: string | null;
  'modelName'?: string | null;
  'name'?: string | null;
  'temperature'?: number | null;
  'type'?: string | null;
  'vendorId'?: string | null;
}
export interface o_agentWorkData {
  'createTime'?: number | null;
  'data'?: string | null;
  'episodesId'?: number | null;
  'id'?: number;
  'key'?: string | null;
  'projectId'?: number | null;
  'updateTime'?: number | null;
}
export interface o_artStyle {
  'fileUrl'?: string | null;
  'id'?: number;
  'label'?: string | null;
  'name'?: string | null;
  'prompt'?: string | null;
}
export interface o_assets {
  'assetsId'?: number | null;
  'audioBindState'?: number | null;
  'describe'?: string | null;
  'flowId'?: number | null;
  'id'?: number;
  'imageId'?: number | null;
  'name'?: string | null;
  'projectId'?: number | null;
  'prompt'?: string | null;
  'promptErrorReason'?: string | null;
  'promptState'?: string | null;
  'remark'?: string | null;
  'scriptId'?: number | null;
  'startTime'?: number | null;
  'type'?: string | null;
}
export interface o_assets2Storyboard {
  'assetId'?: number;
  'storyboardId'?: number;
}
export interface o_assetsRole2Audio {
  'assetsAudioId'?: number;
  'assetsRoleId'?: number;
}
export interface o_auditLog {
  'action': string;
  'actorRole': string;
  'actorUserId': number;
  'createdAt': number;
  'groupId'?: number | null;
  'id'?: number;
  'requestId'?: string | null;
  'result': string;
  'summaryJson'?: string;
  'targetId'?: string | null;
  'targetType': string;
}
export interface o_concurrencyPolicy {
  'createdAt': number;
  'id'?: number;
  'imageLimit': number;
  'scopeId': number;
  'scopeType': string;
  'textLimit': number;
  'totalLimit': number;
  'updatedAt': number;
  'updatedBy': number;
  'videoLimit': number;
}
export interface o_event {
  'createTime'?: number | null;
  'detail'?: string | null;
  'id'?: number;
  'name'?: string | null;
}
export interface o_eventChapter {
  'eventId'?: number | null;
  'id'?: number;
  'novelId'?: number | null;
}
export interface o_generationJob {
  'attemptCount'?: number;
  'cancellationRequestedAt'?: number | null;
  'errorCode'?: string | null;
  'errorMessage'?: string | null;
  'finishedAt'?: number | null;
  'groupId': number;
  'handlerKey': string;
  'heartbeatAt'?: number | null;
  'id'?: number;
  'idempotencyKey': string;
  'leaseExpiresAt'?: number | null;
  'leaseOwner'?: string | null;
  'ownerUserId': number;
  'payloadJson': string;
  'priority'?: number;
  'projectId'?: number | null;
  'providerRequestId'?: string | null;
  'queuedAt': number;
  'resultJson'?: string | null;
  'sourceTaskId'?: number | null;
  'startedAt'?: number | null;
  'status': string;
  'taskType': string;
}
export interface o_group {
  'adminUserId'?: number | null;
  'createdAt': number;
  'creatorLimit'?: number;
  'id'?: number;
  'name': string;
  'status'?: string;
  'updatedAt': number;
}
export interface o_image {
  'assetsId'?: number | null;
  'errorReason'?: string | null;
  'filePath'?: string | null;
  'id'?: number;
  'model'?: string | null;
  'resolution'?: string | null;
  'state'?: string | null;
  'type'?: string | null;
}
export interface o_imageFlow {
  'flowData': string;
  'id'?: number;
  'projectId'?: number | null;
}
export interface o_modelPrompt {
  'fileName'?: string | null;
  'id'?: number;
  'model'?: string | null;
  'path'?: string | null;
  'vendorId'?: string | null;
}
export interface o_novel {
  'chapter'?: string | null;
  'chapterData'?: string | null;
  'chapterIndex'?: number | null;
  'createTime'?: number | null;
  'errorReason'?: string | null;
  'event'?: string | null;
  'eventState'?: number | null;
  'id'?: number;
  'projectId'?: number | null;
  'reel'?: string | null;
}
export interface o_project {
  'artStyle'?: string | null;
  'createTime'?: number | null;
  'directorManual'?: string | null;
  'groupId'?: number | null;
  'id'?: number | null;
  'imageModel'?: string | null;
  'imageQuality'?: string | null;
  'intro'?: string | null;
  'mode'?: string | null;
  'name'?: string | null;
  'ownerUserId'?: number | null;
  'projectType'?: string | null;
  'type'?: string | null;
  'userId'?: number | null;
  'videoModel'?: string | null;
  'videoRatio'?: string | null;
}
export interface o_prompt {
  'data'?: string | null;
  'id'?: number;
  'name'?: string | null;
  'type'?: string | null;
  'useData'?: string | null;
}
export interface o_quotaAccount {
  'balance'?: number;
  'groupId'?: number | null;
  'updatedAt': number;
}
export interface o_quotaLedger {
  'actorUserId'?: number | null;
  'amount': number;
  'balanceAfter': number;
  'balanceBefore': number;
  'createdAt': number;
  'entryType': string;
  'groupId': number;
  'id'?: number;
  'reason': string;
  'usageLedgerId'?: number | null;
}
export interface o_script {
  'content'?: string | null;
  'createTime'?: number | null;
  'errorReason'?: string | null;
  'extractState'?: number | null;
  'id'?: number;
  'name'?: string | null;
  'projectId'?: number | null;
}
export interface o_scriptAssets {
  'assetId'?: number;
  'scriptId'?: number;
}
export interface o_setting {
  'key'?: string | null;
  'value'?: string | null;
}
export interface o_skillAttribution {
  'attribution'?: string;
  'skillId'?: string;
}
export interface o_skillList {
  'createTime': number;
  'description': string;
  'embedding'?: string | null;
  'id'?: string;
  'md5': string;
  'name': string;
  'path': string;
  'state': number;
  'type': string;
  'updateTime': number;
}
export interface o_storyboard {
  'createTime'?: number | null;
  'duration'?: string | null;
  'filePath'?: string | null;
  'flowId'?: number | null;
  'id'?: number;
  'index'?: number | null;
  'projectId'?: number | null;
  'prompt'?: string | null;
  'reason'?: string | null;
  'scriptId'?: number | null;
  'shouldGenerateImage'?: number | null;
  'state'?: string | null;
  'track'?: string | null;
  'trackId'?: number | null;
  'videoDesc'?: string | null;
}
export interface o_tasks {
  'describe'?: string | null;
  'groupId'?: number | null;
  'id'?: number;
  'model'?: string | null;
  'ownerUserId'?: number | null;
  'projectId'?: number | null;
  'reason'?: string | null;
  'relatedObjects'?: string | null;
  'startTime'?: number | null;
  'state'?: string | null;
  'taskClass'?: string | null;
}
export interface o_usageLedger {
  'createdAt': number;
  'currency'?: string | null;
  'estimatedCost'?: number | null;
  'groupId': number;
  'id'?: number;
  'jobId': number;
  'modelId'?: string | null;
  'pricingSnapshotJson'?: string;
  'projectId'?: number | null;
  'providerId'?: string | null;
  'result': string;
  'taskType': string;
  'unitJson'?: string;
  'userId': number;
}
export interface o_user {
  'createdAt'?: number | null;
  'groupId'?: number | null;
  'id'?: number;
  'lastLoginAt'?: number | null;
  'mustChangePassword'?: boolean | null;
  'name'?: string | null;
  'password'?: string | null;
  'passwordHash'?: string | null;
  'role'?: string;
  'status'?: string;
  'updatedAt'?: number | null;
}
export interface o_vendorConfig {
  'enable'?: number | null;
  'id'?: string;
  'inputValues'?: string | null;
  'models'?: string | null;
}
export interface o_video {
  'errorReason'?: string | null;
  'filePath'?: string | null;
  'id'?: number;
  'projectId'?: number | null;
  'scriptId'?: number | null;
  'state'?: string | null;
  'time'?: number | null;
  'videoTrackId'?: number | null;
}
export interface o_videoTrack {
  'duration'?: number | null;
  'id'?: number;
  'projectId'?: number | null;
  'prompt'?: string | null;
  'reason'?: string | null;
  'scriptId'?: number | null;
  'selectVideoId'?: number | null;
  'state'?: string | null;
  'videoId'?: number | null;
}

export interface DB {
  "memories": memories;
  "o_agentDeploy": o_agentDeploy;
  "o_agentWorkData": o_agentWorkData;
  "o_artStyle": o_artStyle;
  "o_assets": o_assets;
  "o_assets2Storyboard": o_assets2Storyboard;
  "o_assetsRole2Audio": o_assetsRole2Audio;
  "o_auditLog": o_auditLog;
  "o_concurrencyPolicy": o_concurrencyPolicy;
  "o_event": o_event;
  "o_eventChapter": o_eventChapter;
  "o_generationJob": o_generationJob;
  "o_group": o_group;
  "o_image": o_image;
  "o_imageFlow": o_imageFlow;
  "o_modelPrompt": o_modelPrompt;
  "o_novel": o_novel;
  "o_project": o_project;
  "o_prompt": o_prompt;
  "o_quotaAccount": o_quotaAccount;
  "o_quotaLedger": o_quotaLedger;
  "o_script": o_script;
  "o_scriptAssets": o_scriptAssets;
  "o_setting": o_setting;
  "o_skillAttribution": o_skillAttribution;
  "o_skillList": o_skillList;
  "o_storyboard": o_storyboard;
  "o_tasks": o_tasks;
  "o_usageLedger": o_usageLedger;
  "o_user": o_user;
  "o_vendorConfig": o_vendorConfig;
  "o_video": o_video;
  "o_videoTrack": o_videoTrack;
}
