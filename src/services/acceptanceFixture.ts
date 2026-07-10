import type { Knex } from "knex";
import { hashPassword } from "@/utils/password";

export interface AcceptanceFixtureResult {
  groups: Array<{ id: number; name: string }>;
  users: Array<{ id: number; name: string; role: "admin" | "creator"; groupId: number }>;
  projectIds: number[];
  taskIds: number[];
  jobIds: number[];
}

async function nextId(trx: Knex.Transaction, table: string): Promise<number> {
  const row = await trx(table).max({ maxId: "id" }).first();
  return Number(row?.maxId ?? 0) + 1;
}

export async function seedAcceptanceFixture(
  connection: Knex,
  password: string,
  now: number = Date.now(),
): Promise<AcceptanceFixtureResult> {
  if (password.length < 8 || password.length > 128) throw new Error("验收账号密码长度必须为至少 8 个字符且不超过 128 个字符");
  const passwordHash = hashPassword(password);

  return connection.transaction(async (trx) => {
    const acceptanceModels = [
      { name: "本地验收图片", modelName: "acceptance-image", type: "image", mode: ["text", "singleImage", "multiReference"] },
      { name: "本地验收视频", modelName: "acceptance-video", type: "video", mode: ["text", "singleImage"], audio: false, durationResolutionMap: [{ duration: [5], resolution: ["720p"] }] },
    ];
    await trx("o_vendorConfig")
      .insert({ id: "null", inputValues: "{}", models: JSON.stringify(acceptanceModels), enable: 1 })
      .onConflict("id")
      .merge({ inputValues: "{}", models: JSON.stringify(acceptanceModels), enable: 1 });

    const ensureUser = async (name: string, role: "admin" | "creator", groupId: number | null) => {
      let user = await trx("o_user").where({ name }).first();
      if (!user) {
        const id = await nextId(trx, "o_user");
        await trx("o_user").insert({ id, name, password: null, passwordHash, role, status: "enabled", groupId, createdAt: now, updatedAt: now, lastLoginAt: null, mustChangePassword: true });
        user = await trx("o_user").where({ id }).first();
      } else {
        await trx("o_user").where({ id: user.id }).update({ password: null, passwordHash, role, status: "enabled", groupId, updatedAt: now, mustChangePassword: true });
        user = await trx("o_user").where({ id: user.id }).first();
      }
      return { id: Number(user.id), name, role, groupId: user.groupId == null ? null : Number(user.groupId) };
    };

    const ensureGroup = async (name: string, adminUserId: number) => {
      let group = await trx("o_group").where({ name }).first();
      if (!group) {
        const [id] = await trx("o_group").insert({ name, adminUserId, creatorLimit: 5, status: "enabled", createdAt: now, updatedAt: now });
        group = await trx("o_group").where({ id }).first();
      } else {
        await trx("o_group").where("adminUserId", adminUserId).whereNot("id", group.id).update({ adminUserId: null, updatedAt: now });
        await trx("o_group").where({ id: group.id }).update({ adminUserId, creatorLimit: 5, status: "enabled", updatedAt: now });
        group = await trx("o_group").where({ id: group.id }).first();
      }
      return { id: Number(group.id), name };
    };

    const adminA = await ensureUser("accept-admin-a", "admin", null);
    const groupA = await ensureGroup("验收一组", adminA.id);
    await trx("o_user").where({ id: adminA.id }).update({ groupId: groupA.id });
    const creatorA1 = await ensureUser("accept-creator-a1", "creator", groupA.id);
    const creatorA2 = await ensureUser("accept-creator-a2", "creator", groupA.id);
    const adminB = await ensureUser("accept-admin-b", "admin", null);
    const groupB = await ensureGroup("验收二组", adminB.id);
    await trx("o_user").where({ id: adminB.id }).update({ groupId: groupB.id });
    const creatorB1 = await ensureUser("accept-creator-b1", "creator", groupB.id);
    const creatorB2 = await ensureUser("accept-creator-b2", "creator", groupB.id);
    const users = [
      { ...adminA, groupId: groupA.id }, creatorA1, creatorA2,
      { ...adminB, groupId: groupB.id }, creatorB1, creatorB2,
    ] as AcceptanceFixtureResult["users"];

    const policyDefaults = {
      group: { totalLimit: 4, textLimit: 3, imageLimit: 2, videoLimit: 1 },
      user: { totalLimit: 2, textLimit: 2, imageLimit: 1, videoLimit: 1 },
    };
    for (const group of [groupA, groupB]) {
      await trx("o_concurrencyPolicy").insert({ scopeType: "group", scopeId: group.id, ...policyDefaults.group, updatedBy: 1, createdAt: now, updatedAt: now }).onConflict(["scopeType", "scopeId"]).merge({ ...policyDefaults.group, updatedBy: 1, updatedAt: now });
    }
    for (const user of users) {
      await trx("o_concurrencyPolicy").insert({ scopeType: "user", scopeId: user.id, ...policyDefaults.user, updatedBy: 1, createdAt: now, updatedAt: now }).onConflict(["scopeType", "scopeId"]).merge({ ...policyDefaults.user, updatedBy: 1, updatedAt: now });
    }

    const ensureProject = async (name: string, ownerUserId: number, groupId: number) => {
      let project = await trx("o_project").where({ name }).first();
      const values = { projectType: "novel", imageModel: "null:acceptance-image", imageQuality: "1K", videoModel: "null:acceptance-video", name, intro: "本地浏览器验收项目", type: "漫剧", artStyle: "验收风格", mode: "text", videoRatio: "16:9", createTime: now, userId: ownerUserId, ownerUserId, groupId };
      if (!project) {
        const id = await nextId(trx, "o_project");
        await trx("o_project").insert({ id, ...values });
        project = { id };
      } else await trx("o_project").where({ id: project.id }).update(values);
      return Number(project.id);
    };
    const projectAId = await ensureProject("验收一组项目", creatorA1.id, groupA.id);
    const projectBId = await ensureProject("验收二组项目", creatorB1.id, groupB.id);

    const ensureProductionContent = async (label: string, projectId: number) => {
      let novel = await trx("o_novel").where({ projectId, chapter: `${label}原文` }).first();
      if (!novel) {
        const id = await nextId(trx, "o_novel");
        await trx("o_novel").insert({ id, chapterIndex: 1, reel: "第一卷", chapter: `${label}原文`, chapterData: "测试角色走入测试场景。", projectId, eventState: 1, event: "验收事件", errorReason: null, createTime: now });
        novel = { id };
      }

      let script = await trx("o_script").where({ projectId, name: `${label}剧本` }).first();
      if (!script) {
        const id = await nextId(trx, "o_script");
        await trx("o_script").insert({ id, name: `${label}剧本`, content: "第一场：测试角色走入测试场景。", projectId, extractState: 1, createTime: now, errorReason: null });
        script = { id };
      }

      let asset = await trx("o_assets").where({ projectId, name: `${label}角色` }).first();
      if (!asset) {
        const imageId = await nextId(trx, "o_image");
        await trx("o_image").insert({ id: imageId, filePath: null, type: "role", assetsId: null, model: "null:acceptance-image", resolution: "1K", state: "", errorReason: null });
        const id = await nextId(trx, "o_assets");
        await trx("o_assets").insert({ id, name: `${label}角色`, prompt: "电影感角色立绘，正面站立", remark: "", type: "role", describe: "用于浏览器图片生成验收", scriptId: script.id, imageId, assetsId: null, projectId, startTime: now, promptState: "已完成", audioBindState: null });
        await trx("o_image").where({ id: imageId }).update({ assetsId: id });
        asset = { id, imageId };
      }
      if (!(await trx("o_scriptAssets").where({ scriptId: script.id, assetId: asset.id }).first())) {
        await trx("o_scriptAssets").insert({ scriptId: script.id, assetId: asset.id });
      }

      let track = await trx("o_videoTrack").where({ projectId, scriptId: script.id, prompt: `${label}视频提示词` }).first();
      if (!track) {
        const id = await nextId(trx, "o_videoTrack");
        await trx("o_videoTrack").insert({ id, videoId: null, projectId, scriptId: script.id, state: "已完成", reason: null, prompt: `${label}视频提示词`, selectVideoId: null, duration: 5 });
        track = { id };
      }

      let storyboard = await trx("o_storyboard").where({ projectId, scriptId: script.id, prompt: `${label}分镜提示词` }).first();
      if (!storyboard) {
        const id = await nextId(trx, "o_storyboard");
        await trx("o_storyboard").insert({ id, scriptId: script.id, prompt: `${label}分镜提示词`, filePath: null, duration: "5", state: "未生成", trackId: track.id, reason: null, track: "main", videoDesc: "角色缓慢走入画面", shouldGenerateImage: 0, projectId, flowId: null, index: 1, createTime: now });
        storyboard = { id };
      }

      const flowData = JSON.stringify({ scriptPlan: "", storyboardTable: "", workbench: { videoList: [] } });
      const work = await trx("o_agentWorkData").where({ projectId, episodesId: script.id, key: "acceptance-production" }).first();
      if (work) await trx("o_agentWorkData").where({ id: work.id }).update({ data: flowData, updateTime: now });
      else await trx("o_agentWorkData").insert({ id: await nextId(trx, "o_agentWorkData"), projectId, episodesId: script.id, key: "acceptance-production", data: flowData, createTime: now, updateTime: now });
    };
    await ensureProductionContent("验收一组", projectAId);
    await ensureProductionContent("验收二组", projectBId);

    const ensureTask = async (marker: string, values: Record<string, unknown>) => {
      let task = await trx("o_tasks").where({ relatedObjects: marker }).first();
      if (!task) {
        const id = await nextId(trx, "o_tasks");
        await trx("o_tasks").insert({ id, relatedObjects: marker, ...values });
        task = { id };
      } else await trx("o_tasks").where({ id: task.id }).update(values);
      return Number(task.id);
    };
    const taskIds = [
      await ensureTask("acceptance:a-completed", { projectId: projectAId, ownerUserId: creatorA1.id, groupId: groupA.id, taskClass: "image", model: "acceptance-image", describe: "图片任务验收", state: "completed", startTime: now - 4_000, reason: null }),
      await ensureTask("acceptance:a-failed", { projectId: projectAId, ownerUserId: creatorA2.id, groupId: groupA.id, taskClass: "video", model: "acceptance-video", describe: "视频任务验收", state: "failed", startTime: now - 3_000, reason: "验收失败样本" }),
      await ensureTask("acceptance:b-completed", { projectId: projectBId, ownerUserId: creatorB1.id, groupId: groupB.id, taskClass: "text", model: "acceptance-text", describe: "文本任务验收", state: "completed", startTime: now - 2_000, reason: null }),
      await ensureTask("acceptance:b-cancelled", { projectId: projectBId, ownerUserId: creatorB2.id, groupId: groupB.id, taskClass: "image", model: "acceptance-image", describe: "取消任务验收", state: "cancelled", startTime: now - 1_000, reason: "用户取消" }),
    ];

    const jobSpecs = [
      ["acceptance:a-succeeded", groupA.id, creatorA1.id, projectAId, "text", "succeeded"],
      ["acceptance:a-failed", groupA.id, creatorA2.id, projectAId, "image", "failed"],
      ["acceptance:a-cancelled", groupA.id, creatorA1.id, projectAId, "video", "cancelled"],
      ["acceptance:a-attention", groupA.id, creatorA2.id, projectAId, "video", "needs_attention"],
      ["acceptance:b-succeeded", groupB.id, creatorB1.id, projectBId, "image", "succeeded"],
      ["acceptance:b-failed", groupB.id, creatorB2.id, projectBId, "text", "failed"],
    ] as const;
    const jobs = new Map<string, number>();
    for (const [key, groupId, ownerUserId, projectId, taskType, status] of jobSpecs) {
      let job = await trx("o_generationJob").where({ idempotencyKey: key }).first();
      const values = { groupId, ownerUserId, projectId, sourceTaskId: null, handlerKey: "acceptance.fixture", taskType, status, priority: 0, payloadJson: "{}", resultJson: status === "succeeded" ? JSON.stringify({ fixture: true }) : null, errorCode: status === "failed" ? "ACCEPTANCE_FAILURE" : status === "needs_attention" ? "ACCEPTANCE_ATTENTION" : null, errorMessage: status === "failed" ? "验收失败样本" : status === "needs_attention" ? "需要人工处理的验收样本" : null, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, attemptCount: status === "succeeded" || status === "failed" ? 1 : 0, providerRequestId: status === "succeeded" ? `fixture-${key}` : null, cancellationRequestedAt: status === "cancelled" ? now - 500 : null, queuedAt: now - 10_000, startedAt: status === "succeeded" || status === "failed" ? now - 9_000 : null, finishedAt: ["succeeded", "failed", "cancelled"].includes(status) ? now - 8_000 : null };
      if (!job) {
        const [id] = await trx("o_generationJob").insert({ idempotencyKey: key, ...values });
        job = { id };
      } else await trx("o_generationJob").where({ id: job.id }).update(values);
      jobs.set(key, Number(job.id));
    }

    const usageSpecs = [
      { key: "acceptance:a-succeeded", groupId: groupA.id, userId: creatorA1.id, projectId: projectAId, providerId: "fixture-provider", modelId: "acceptance-text", taskType: "text", estimatedCost: 1.25 },
      { key: "acceptance:b-succeeded", groupId: groupB.id, userId: creatorB1.id, projectId: projectBId, providerId: "fixture-provider", modelId: "acceptance-image", taskType: "image", estimatedCost: 2.5 },
    ];
    const fixtureUsage = new Map<number, { id: number; key: string; estimatedCost: number }>();
    for (const usage of usageSpecs) {
      const jobId = Number(jobs.get(usage.key));
      const values = { jobId, groupId: usage.groupId, userId: usage.userId, projectId: usage.projectId, providerId: usage.providerId, modelId: usage.modelId, taskType: usage.taskType, unitJson: "{}", estimatedCost: usage.estimatedCost, currency: "CNY", pricingSnapshotJson: JSON.stringify({ fixture: true }), result: "succeeded", createdAt: now - 7_000 };
      const existing = await trx("o_usageLedger").where({ jobId }).first();
      let usageId: number;
      if (existing) {
        await trx("o_usageLedger").where({ id: existing.id }).update(values);
        usageId = Number(existing.id);
      } else {
        const [id] = await trx("o_usageLedger").insert(values);
        usageId = Number(id);
      }
      fixtureUsage.set(usage.groupId, { id: usageId, key: usage.key, estimatedCost: usage.estimatedCost });
    }

    for (const group of [groupA, groupB]) {
      const usage = fixtureUsage.get(group.id);
      const balanceAfter = 500 - (usage?.estimatedCost ?? 0);
      await trx("o_quotaAccount").insert({ groupId: group.id, balance: balanceAfter, updatedAt: now }).onConflict("groupId").merge({ balance: balanceAfter, updatedAt: now });
      const existing = await trx("o_quotaLedger").where({ groupId: group.id, reason: "本地验收 fixture 初始额度" }).first();
      if (!existing) await trx("o_quotaLedger").insert({ groupId: group.id, entryType: "manual_topup", amount: 500, balanceBefore: 0, balanceAfter: 500, actorUserId: 1, usageLedgerId: null, reason: "本地验收 fixture 初始额度", createdAt: now });
      if (usage) {
        const values = { groupId: group.id, entryType: "usage_debit", amount: -usage.estimatedCost, balanceBefore: 500, balanceAfter, actorUserId: null, usageLedgerId: usage.id, reason: `本地验收 fixture 用量扣款:${usage.key}`, createdAt: now + 1 };
        const existingDebit = await trx("o_quotaLedger").where({ usageLedgerId: usage.id, entryType: "usage_debit" }).first();
        if (existingDebit) await trx("o_quotaLedger").where({ id: existingDebit.id }).update(values);
        else await trx("o_quotaLedger").insert(values);
      }
    }

    return { groups: [groupA, groupB], users, projectIds: [projectAId, projectBId], taskIds, jobIds: [...jobs.values()] };
  });
}
