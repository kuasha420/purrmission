import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDiscordPrincipal } from './principal.js';
import { createInMemoryRepositories } from './repositories.mock.js';
import { createServices } from './services.js';
import { resolveTargetVersions } from './target_versions.js';

async function fixture() {
  const repositories = createInMemoryRepositories();
  const services = createServices({ repositories });
  const project = await repositories.projects.createProject({
    name: 'Alpha',
    description: 'Visible metadata',
    ownerId: 'owner',
  });
  const resource = await repositories.resources.create({
    id: 'resource-alpha',
    name: 'Alpha Production',
    mode: 'ONE_OF_N',
    apiKey: null,
  });
  const environment = await repositories.projects.createEnvironment({
    projectId: project.id,
    name: 'Production',
    slug: 'production',
    resourceId: resource.id,
  });
  await repositories.projects.addMember({
    projectId: project.id,
    userId: 'writer',
    role: 'WRITER',
    addedBy: 'owner',
  });
  await repositories.projects.addMember({
    projectId: project.id,
    userId: 'reader',
    role: 'READER',
    addedBy: 'owner',
  });
  await repositories.guardians.add({
    resourceId: resource.id,
    discordUserId: 'guardian',
    role: 'GUARDIAN',
  });
  const secret = await repositories.resourceFields.create({
    resourceId: resource.id,
    name: 'DATABASE_URL',
    value: 'protected-value',
  });
  const account = await repositories.totp.create({
    ownerDiscordUserId: 'custody-owner',
    accountName: 'Production OTP',
    issuer: 'Purrmission',
    secret: 'JBSWY3DPEHPK3PXP',
    backupKey: 'recovery-material',
  });
  await repositories.resources.update(resource.id, { totpAccountId: account.id });
  const versions = await resolveTargetVersions(
    repositories,
    resource.id,
    'secret.value.read',
    secret.name
  );
  assert.ok(versions);
  const request = await repositories.approvalRequests.create({
    id: 'request-alpha-secret',
    resourceId: resource.id,
    status: 'PENDING',
    context: null,
    requesterId: 'requester',
    requesterType: 'DISCORD_USER',
    authKind: 'DISCORD',
    action: 'secret.value.read',
    targetKey: secret.name,
    targetVersion: versions.targetVersion,
    policyVersion: versions.policyVersion,
    constraints: null,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { repositories, services, project, environment, resource, secret, account, request };
}

describe('repository-backed metadata persistence', () => {
  it('discovers only subject-bound projects and exact resources', async () => {
    const { services, project, environment, resource } = await fixture();

    for (const subject of ['owner', 'writer', 'reader']) {
      const projects = await services.metadata.listProjects(createDiscordPrincipal(subject));
      assert.deepEqual(
        projects.items.map(({ id }) => id),
        [project.id]
      );
    }
    assert.deepEqual(
      (await services.metadata.listProjects(createDiscordPrincipal('guardian'))).items,
      []
    );
    assert.deepEqual(
      (await services.metadata.listProjects(createDiscordPrincipal('stranger'))).items,
      []
    );
    assert.deepEqual(
      (await services.metadata.listEnvironments(createDiscordPrincipal('writer'))).items.map(
        ({ id }) => id
      ),
      [environment.id]
    );
    assert.deepEqual(
      (await services.metadata.listEnvironments(createDiscordPrincipal('guardian'))).items,
      []
    );
    assert.deepEqual(
      (await services.metadata.listResources(createDiscordPrincipal('guardian'))).items.map(
        ({ id }) => id
      ),
      [resource.id]
    );
    assert.deepEqual(
      (await services.metadata.listResources(createDiscordPrincipal('stranger'))).items,
      []
    );
  });

  it('never enumerates cross-project resources, secrets, or globally linked TOTP', async () => {
    const { repositories, services, resource, secret, account } = await fixture();
    const hiddenProject = await repositories.projects.createProject({
      name: 'Hidden',
      ownerId: 'other-owner',
    });
    const hiddenResource = await repositories.resources.create({
      id: 'resource-hidden',
      name: 'Hidden Production',
      mode: 'ONE_OF_N',
      apiKey: null,
    });
    await repositories.projects.createEnvironment({
      projectId: hiddenProject.id,
      name: 'Hidden',
      slug: 'hidden',
      resourceId: hiddenResource.id,
    });
    const hiddenSecret = await repositories.resourceFields.create({
      resourceId: hiddenResource.id,
      name: 'HIDDEN_VALUE',
      value: 'must-not-enumerate',
    });
    const hiddenAccount = await repositories.totp.create({
      ownerDiscordUserId: 'other-custody-owner',
      accountName: 'Hidden OTP',
      secret: 'KRUGS4ZANFZSAYJA',
    });
    await repositories.resources.update(hiddenResource.id, { totpAccountId: hiddenAccount.id });

    const writer = createDiscordPrincipal('writer');
    assert.deepEqual(
      (await services.metadata.listResources(writer)).items.map(({ id }) => id),
      [resource.id]
    );
    assert.deepEqual(
      (await services.metadata.listSecrets(writer)).items.map(({ id }) => id),
      [secret.id]
    );
    assert.deepEqual(
      (await services.metadata.listTOTPAccounts(writer)).items.map((item) =>
        item.kind === 'TOTP_LINK_STATUS' ? item.resourceId : item.id
      ),
      [resource.id]
    );
    assert.equal(
      JSON.stringify(await services.metadata.listTOTPAccounts(writer)).includes(hiddenAccount.id),
      false
    );
    assert.equal(
      JSON.stringify(await services.metadata.listSecrets(writer)).includes(hiddenSecret.id),
      false
    );
    assert.equal(
      JSON.stringify(await services.metadata.listTOTPAccounts(writer)).includes(account.secret),
      false
    );
  });

  it('uses metadata-only secret/TOTP projections with role-minimized output', async () => {
    const { services, secret, account } = await fixture();
    const secrets = await services.metadata.listSecrets(createDiscordPrincipal('reader'));
    assert.equal(secrets.items[0]?.id, secret.id);
    assert.equal(secrets.items[0]?.version, secret.version);
    assert.equal(JSON.stringify(secrets).includes('protected-value'), false);

    assert.deepEqual(
      (await services.metadata.listSecrets(createDiscordPrincipal('guardian'))).items,
      []
    );
    const linked = await services.metadata.listTOTPAccounts(createDiscordPrincipal('reader'));
    assert.equal(linked.items[0]?.kind, 'TOTP_LINK_STATUS');
    assert.equal(JSON.stringify(linked).includes('Production OTP'), false);
    assert.equal(JSON.stringify(linked).includes('recovery-material'), false);

    const personal = await services.metadata.listTOTPAccounts(
      createDiscordPrincipal('custody-owner')
    );
    assert.equal(personal.items[0]?.kind, 'TOTP_ACCOUNT');
    assert.equal(personal.items[0]?.scope, 'PERSONAL');
    assert.equal('id' in (personal.items[0] ?? {}) ? personal.items[0].id : null, account.id);
    assert.equal(JSON.stringify(personal).includes('JBSWY3DPEHPK3PXP'), false);
  });

  it('never calls value-bearing repository methods while producing metadata', async () => {
    const { repositories, services } = await fixture();
    const valueRead = async () => {
      throw new Error('value-bearing repository method reached');
    };
    repositories.resources.findById = valueRead;
    repositories.resourceFields.findByResourceId = valueRead;
    repositories.totp.findById = valueRead;
    repositories.approvalRequests.findById = valueRead;
    repositories.approvalRequests.findByRequesterId = valueRead;
    repositories.approvalGrants.findByRequestId = valueRead;

    assert.equal(
      (await services.metadata.listSecrets(createDiscordPrincipal('reader'))).items.length,
      1
    );
    assert.equal(
      (await services.metadata.listTOTPAccounts(createDiscordPrincipal('reader'))).items.length,
      1
    );
    assert.equal(
      (await services.metadata.listTOTPAccounts(createDiscordPrincipal('custody-owner'))).items
        .length,
      1
    );
    assert.equal(
      (await services.metadata.listRequests(createDiscordPrincipal('requester'))).items.length,
      1
    );
  });

  it('limits request detail to the requester and eligible decision queue', async () => {
    const { services, request } = await fixture();
    const own = await services.metadata.listRequests(createDiscordPrincipal('requester'));
    assert.deepEqual(
      own.items.map(({ id }) => id),
      [request.id]
    );
    const queue = await services.metadata.listRequests(createDiscordPrincipal('guardian'));
    assert.deepEqual(
      queue.items.map(({ id }) => id),
      [request.id]
    );
    assert.deepEqual(
      (await services.metadata.listRequests(createDiscordPrincipal('reader'))).items,
      []
    );
    assert.deepEqual(
      (await services.metadata.listRequests(createDiscordPrincipal('stranger'))).items,
      []
    );
  });

  it('retains immutable request metadata after the current target changes', async () => {
    const { repositories, services, secret, account, request, resource } = await fixture();
    await repositories.resourceFields.update(secret.id, 'rotated-value');
    const secretHistory = await services.metadata.listRequests(createDiscordPrincipal('requester'));
    assert.equal(secretHistory.items[0]?.id, request.id);
    assert.equal(secretHistory.items[0]?.target.targetVersion, request.targetVersion);

    const created = await services.approval.createApprovalRequest({
      resourceId: resource.id,
      requesterId: 'totp-requester',
      requesterType: 'DISCORD_USER',
      authKind: 'DISCORD',
      action: 'totp.code.read',
    });
    assert.ok(created.request);
    assert.equal(created.request.targetKey, account.id);
    await repositories.resources.update(resource.id, { totpAccountId: null });
    const totpHistory = await services.metadata.listRequests(
      createDiscordPrincipal('totp-requester')
    );
    assert.equal(totpHistory.items[0]?.id, created.request.id);
    assert.equal(totpHistory.items[0]?.target.kind, 'TOTP_ACCOUNT');
    if (totpHistory.items[0]?.target.kind === 'TOTP_ACCOUNT') {
      assert.equal(totpHistory.items[0].target.totpAccountId, account.id);
    }
  });

  it('advances exact secret, link, resource, and project policy versions', async () => {
    const { repositories, project, resource, secret, account } = await fixture();
    const originalProject = await repositories.projects.findById(project.id);
    const originalResource = await repositories.resources.findById(resource.id);
    assert.ok(originalProject && originalResource);
    const originalProjectVersion = originalProject.policyVersion;
    const originalResourceVersion = originalResource.version;

    const updatedSecret = await repositories.resourceFields.update(secret.id, 'new-value');
    assert.notEqual(updatedSecret.version, secret.version);
    const afterSecret = await repositories.resources.findById(resource.id);
    assert.notEqual(afterSecret?.version, originalResourceVersion);

    const priorLinkVersion = afterSecret?.totpLinkVersion;
    await repositories.resources.update(resource.id, { totpAccountId: null });
    const afterUnlink = await repositories.resources.findById(resource.id);
    assert.notEqual(afterUnlink?.totpLinkVersion, priorLinkVersion);
    await repositories.resources.update(resource.id, { totpAccountId: account.id });
    const afterRelink = await repositories.resources.findById(resource.id);
    assert.notEqual(afterRelink?.totpLinkVersion, afterUnlink?.totpLinkVersion);

    await repositories.projects.addMember({
      projectId: project.id,
      userId: 'another-reader',
      role: 'READER',
      addedBy: 'owner',
    });
    assert.notEqual(
      (await repositories.projects.findById(project.id))?.policyVersion,
      originalProjectVersion
    );
  });
});
