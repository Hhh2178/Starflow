import { db, dbReady } from "@/utils/db";
import { coreGenerationRegistry } from "@/jobs/coreRegistry";
import { enqueueEditImageJob, enqueueVideoJobs } from "@/services/generationWorkflows";
import { enqueueAiRegexJobs } from "@/services/productionTextWorkflows";
import { claimNextJob, executeClaimedJob } from "@/services/generationScheduler";
import type { AuthUser } from "@/types/auth";

function requiredInteger(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

async function executeNext(groupId: number, expectedJobId: number, label: string) {
  const claimed = await claimNextJob(groupId, {
    connection: db,
    leaseOwner: `real-billing-${label}`,
  });
  if (!claimed || claimed.id !== expectedJobId) throw new Error(`${label} 未领取到预期任务`);
  await executeClaimedJob(claimed.id, {
    connection: db,
    registry: coreGenerationRegistry,
    heartbeatIntervalMs: 1_000,
  });
  const job = await db("o_generationJob")
    .where({ id: claimed.id })
    .select("id", "taskType", "status", "errorCode")
    .first();
  const reservation = await db("o_quotaReservation")
    .where({ jobId: claimed.id })
    .select("reservedAmount", "finalAmount", "status")
    .first();
  return { job, reservation };
}

async function main() {
  if (process.env.STARS_RUN_REAL_PROVIDER_BILLING !== "1") {
    throw new Error("必须显式设置 STARS_RUN_REAL_PROVIDER_BILLING=1");
  }
  await dbReady;
  const projectId = requiredInteger("STARS_VALIDATION_PROJECT_ID");
  const groupId = requiredInteger("STARS_VALIDATION_GROUP_ID");
  const userId = requiredInteger("STARS_VALIDATION_USER_ID");
  const scriptId = requiredInteger("STARS_VALIDATION_SCRIPT_ID");
  const trackId = requiredInteger("STARS_VALIDATION_TRACK_ID");
  const referenceAssetId = requiredInteger("STARS_VALIDATION_REFERENCE_ASSET_ID");
  const actor: AuthUser = { id: userId, name: "billing-validation", role: "creator", groupId };
  const before = await db("o_quotaAccount")
    .where({ groupId })
    .select("balance", "reservedBalance", "billingStatus")
    .first();
  const stamp = Date.now().toString();

  const textQueued = await enqueueAiRegexJobs(
    actor,
    { projectId, content: "第1集 初遇\n第2集 重逢" },
    `billing-text-${stamp}`,
    db,
  );
  const text = await executeNext(groupId, textQueued[0].jobId, "text");

  const imageQueued = await enqueueEditImageJob(actor, {
    projectId,
    model: "grsai:gpt-image-2",
    prompt: "极简蓝色星光图标，纯色背景，无文字",
    referencePaths: [],
    size: "1K",
    aspectRatio: "1:1",
  }, `billing-image-${stamp}`, db);
  const image = await executeNext(groupId, imageQueued.jobId, "image");

  const videoQueued = await enqueueVideoJobs(actor, {
    projectId,
    scriptId,
    model: "aicopy:grok-imagine-video-1.5-preview",
    mode: "startFrameOptional",
    resolution: "720p",
    audio: false,
    tracks: [{
      trackId,
      prompt: "角色轻微眨眼，镜头固定，动作自然",
      duration: 6,
      references: [{ kind: "asset", id: referenceAssetId }],
    }],
  }, `billing-video-${stamp}`, db);
  const video = await executeNext(groupId, videoQueued[0].jobId, "video");

  const after = await db("o_quotaAccount")
    .where({ groupId })
    .select("balance", "reservedBalance", "billingStatus")
    .first();
  console.log(JSON.stringify({ before, after, results: [text, image, video] }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
    process.exit(process.exitCode ?? 0);
  });
