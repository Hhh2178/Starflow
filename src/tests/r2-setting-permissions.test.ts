import assert from "node:assert/strict";
import startServe, { closeServe } from "@/app";
import u from "@/utils";

type ApiResult = {
  status: number;
  body: any;
};

async function request(baseUrl: string, path: string, token?: string, init: RequestInit = {}): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: token } : {}),
      ...(init.headers || {}),
    },
  });

  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}

async function login(baseUrl: string, username: string, password: string): Promise<string> {
  const result = await request(baseUrl, "/api/login/login", undefined, {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  assert.equal(result.status, 200, `login failed for ${username}`);
  assert.equal(typeof result.body?.data?.token, "string");
  return result.body.data.token;
}

async function main() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
  const creatorName = `r2c-${suffix}`;
  const renamedCreatorName = `r2n-${suffix}`;
  const adminName = `r2a-${suffix}`;
  const forbiddenAdminName = `r2f-${suffix}`;
  const temporaryPassword = "TempPass123";
  const replacementPassword = "NextPass123";
  let baseUrl = "";
  let adminGroupId: number | null = null;

  try {
    const port = await startServe(true);
    baseUrl = `http://127.0.0.1:${port}`;
    const superAdminToken = await login(baseUrl, "admin", "admin123");

    const me = await request(baseUrl, "/api/setting/loginConfig/me", superAdminToken);
    assert.equal(me.status, 200);
    assert.equal(me.body.data.role, "super_admin");
    assert.equal("password" in me.body.data, false);
    assert.equal("passwordHash" in me.body.data, false);

    const createAdmin = await request(baseUrl, "/api/setting/userManagement/createUser", superAdminToken, {
      method: "POST",
      body: JSON.stringify({
        name: adminName,
        password: temporaryPassword,
        role: "admin",
      }),
    });
    assert.equal(createAdmin.status, 200);
    adminGroupId = Number(createAdmin.body.data.groupId);
    assert.ok(adminGroupId > 0);

    const createCreator = await request(baseUrl, "/api/setting/userManagement/createUser", superAdminToken, {
      method: "POST",
      body: JSON.stringify({
        name: creatorName,
        password: temporaryPassword,
        role: "creator",
        groupId: adminGroupId,
      }),
    });
    assert.equal(createCreator.status, 200);
    const creatorId = Number(createCreator.body.data.id);

    const storedCreator = await u.db("o_user").where("id", creatorId).first();
    if (!storedCreator) throw new Error("created user was not persisted");
    assert.equal(storedCreator.password, null);
    assert.equal(typeof storedCreator.passwordHash, "string");
    assert.equal(storedCreator.mustChangePassword, 1);

    const creatorToken = await login(baseUrl, creatorName, temporaryPassword);
    const creatorVendorAccess = await request(
      baseUrl,
      "/api/setting/vendorConfig/getVendorList",
      creatorToken,
    );
    assert.equal(creatorVendorAccess.status, 403);

    const creatorUserAccess = await request(
      baseUrl,
      "/api/setting/userManagement/listUsers",
      creatorToken,
    );
    assert.equal(creatorUserAccess.status, 403);

    const profileUpdate = await request(
      baseUrl,
      "/api/setting/loginConfig/updateUserPwd",
      creatorToken,
      {
        method: "POST",
        body: JSON.stringify({ name: renamedCreatorName, password: replacementPassword }),
      },
    );
    assert.equal(profileUpdate.status, 200);
    const renamedCreatorToken = await login(baseUrl, renamedCreatorName, replacementPassword);
    const creatorMe = await request(baseUrl, "/api/setting/loginConfig/me", renamedCreatorToken);
    assert.equal(creatorMe.body.data.mustChangePassword, false);

    const adminToken = await login(baseUrl, adminName, temporaryPassword);
    const adminUsers = await request(baseUrl, "/api/setting/userManagement/listUsers", adminToken);
    assert.equal(adminUsers.status, 200);
    assert.ok(adminUsers.body.data.every((user: any) => user.role === "creator"));
    assert.ok(adminUsers.body.data.every((user: any) => !("passwordHash" in user) && !("password" in user)));

    const adminCreateAdmin = await request(baseUrl, "/api/setting/userManagement/createUser", adminToken, {
      method: "POST",
      body: JSON.stringify({
        name: forbiddenAdminName,
        password: temporaryPassword,
        role: "admin",
      }),
    });
    assert.equal(adminCreateAdmin.status, 403);

    const disableCreator = await request(baseUrl, "/api/setting/userManagement/updateUser", adminToken, {
      method: "POST",
      body: JSON.stringify({ id: creatorId, status: "disabled", role: "creator", name: renamedCreatorName }),
    });
    assert.equal(disableCreator.status, 200);

    const disabledTokenAccess = await request(baseUrl, "/api/setting/loginConfig/me", renamedCreatorToken);
    assert.equal(disabledTokenAccess.status, 403);

    const disabledLogin = await request(baseUrl, "/api/login/login", undefined, {
      method: "POST",
      body: JSON.stringify({ username: renamedCreatorName, password: replacementPassword }),
    });
    assert.equal(disabledLogin.status, 403);
  } finally {
    await u.db("o_user").whereIn("name", [creatorName, renamedCreatorName, adminName, forbiddenAdminName]).delete();
    if (adminGroupId !== null) await u.db("o_group").where("id", adminGroupId).delete();
    if (baseUrl) await closeServe();
  }
}

main().then(
  () => {
    console.log("R2 setting permission smoke passed");
    process.exit(0);
  },
  (reason) => {
    console.error(reason);
    process.exit(1);
  },
);
