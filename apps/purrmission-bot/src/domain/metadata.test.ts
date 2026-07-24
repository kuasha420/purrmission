import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createInMemoryRepositories } from './repositories.mock.js';
import { ResourceService } from './services.js';
import { ProjectService } from './project.js';

describe('Metadata Projections, Visibility Discovery and Version Rotations', () => {
  let repos: ReturnType<typeof createInMemoryRepositories>;
  let resourceService: ResourceService;
  let projectService: ProjectService;

  beforeEach(() => {
    repos = createInMemoryRepositories();
    resourceService = new ResourceService({ repositories: repos });
    projectService = new ProjectService(repos.projects, resourceService);
  });

  describe('Decryption Prevention and Projections', () => {
    it('should query TOTP metadata without returning sensitive fields', async () => {
      const ownerId = 'user-owner';
      // Create a TOTP account in the repository
      const acc = await repos.totp.create({
        ownerDiscordUserId: ownerId,
        accountName: 'my-bank',
        issuer: 'BankCo',
        secret: 'SUPER_SECRET_DECRYPTED_VAL',
        backupKey: 'BACKUP_KEY_DECRYPTED_VAL',
      });

      // Verify direct retrieval from findById has secret
      const raw = await repos.totp.findById(acc.id);
      assert.ok(raw);
      assert.strictEqual(raw.secret, 'SUPER_SECRET_DECRYPTED_VAL');

      // Verify metadata query for owner returns metadata without secret or backupKey
      const metadataList = await repos.totp.findMetadataByOwnerDiscordUserId(ownerId);
      assert.strictEqual(metadataList.length, 1);
      const meta = metadataList[0];
      assert.strictEqual(meta.accountName, 'my-bank');
      assert.strictEqual((meta as any).secret, undefined);
      assert.strictEqual((meta as any).backupKey, undefined);
    });

    it('should query ResourceField metadata without returning value', async () => {
      const res = await repos.resources.create({
        id: 'res-id',
        name: 'database-creds',
        mode: 'ONE_OF_N',
        apiKey: 'key',
      });

      await repos.resourceFields.create({
        resourceId: res.id,
        name: 'password',
        value: 'decrypted-db-password',
      });

      // Direct find returns value
      const rawField = await repos.resourceFields.findByResourceAndName(res.id, 'password');
      assert.ok(rawField);
      assert.strictEqual(rawField.value, 'decrypted-db-password');

      // Metadata findByResourceAndName has no value
      const metaField = await repos.resourceFields.findMetadataByResourceAndName(
        res.id,
        'password'
      );
      assert.ok(metaField);
      assert.strictEqual(metaField.name, 'password');
      assert.strictEqual((metaField as any).value, undefined);

      // Metadata findByResourceId has no value
      const metaList = await repos.resourceFields.findMetadataByResourceId(res.id);
      assert.strictEqual(metaList.length, 1);
      assert.strictEqual(metaList[0].name, 'password');
      assert.strictEqual((metaList[0] as any).value, undefined);
    });
  });

  describe('Discovery and Visibility Boundary Controls', () => {
    it('should only discover projects owned or where user is member', async () => {
      const ownerId = 'owner-john';
      const writerId = 'writer-alice';
      const readerId = 'reader-bob';
      const strangerId = 'stranger-evil';

      const project = await projectService.createProject({
        name: 'Alpha Project',
        description: 'First system',
        ownerId,
      });

      // Add memberships
      await projectService.addMember(project.id, writerId, 'WRITER', ownerId);
      await projectService.addMember(project.id, readerId, 'READER', ownerId);

      // Check visibility for owner
      const ownerProjects = await projectService.listProjects(ownerId);
      assert.strictEqual(ownerProjects.length, 1);
      assert.strictEqual(ownerProjects[0].id, project.id);

      // Check visibility for writer member
      const writerProjects = await projectService.listProjects(writerId);
      assert.strictEqual(writerProjects.length, 1);
      assert.strictEqual(writerProjects[0].id, project.id);

      // Check visibility for reader member
      const readerProjects = await projectService.listProjects(readerId);
      assert.strictEqual(readerProjects.length, 1);
      assert.strictEqual(readerProjects[0].id, project.id);

      // Negative boundary control: stranger should not see project
      const strangerProjects = await projectService.listProjects(strangerId);
      assert.strictEqual(strangerProjects.length, 0);
    });
  });

  describe('Version Rotations', () => {
    it('should rotate resource version when fields change', async () => {
      const res = await repos.resources.create({
        id: 'res-id',
        name: 'database-creds',
        mode: 'ONE_OF_N',
        apiKey: 'key',
      });
      const initialVersion = res.version;
      assert.ok(initialVersion);

      // 1. Create field -> rotates version
      const f1 = await repos.resourceFields.create({
        resourceId: res.id,
        name: 'username',
        value: 'admin',
      });
      const resAfterCreate = await repos.resources.findById(res.id);
      assert.ok(resAfterCreate);
      assert.notStrictEqual(resAfterCreate.version, initialVersion);

      // 2. Update field -> rotates version
      const v2 = resAfterCreate.version;
      await repos.resourceFields.update(f1.id, 'admin2');
      const resAfterUpdate = await repos.resources.findById(res.id);
      assert.ok(resAfterUpdate);
      assert.notStrictEqual(resAfterUpdate.version, v2);

      // 3. Delete field -> rotates version
      const v3 = resAfterUpdate.version;
      await repos.resourceFields.delete(f1.id);
      const resAfterDelete = await repos.resources.findById(res.id);
      assert.ok(resAfterDelete);
      assert.notStrictEqual(resAfterDelete.version, v3);
    });

    it('should rotate resource version when guardians change', async () => {
      const res = await repos.resources.create({
        id: 'res-id',
        name: 'database-creds',
        mode: 'ONE_OF_N',
        apiKey: 'key',
      });
      const v1 = res.version;

      // Add guardian -> rotates parent resource version
      await repos.guardians.add({
        id: 'g-1',
        resourceId: res.id,
        discordUserId: 'user-g',
        role: 'GUARDIAN',
      });
      const resAfterAdd = await repos.resources.findById(res.id);
      assert.ok(resAfterAdd);
      assert.notStrictEqual(resAfterAdd.version, v1);

      // Remove guardian -> rotates parent resource version
      const v2 = resAfterAdd.version;
      await repos.guardians.remove(res.id, 'user-g');
      const resAfterRemove = await repos.resources.findById(res.id);
      assert.ok(resAfterRemove);
      assert.notStrictEqual(resAfterRemove.version, v2);
    });

    it('should rotate project policyVersion when memberships change', async () => {
      const project = await projectService.createProject({
        name: 'Beta Project',
        ownerId: 'owner-jane',
      });
      const initialPolicyVersion = project.policyVersion;
      assert.ok(initialPolicyVersion);

      // Add member -> rotates project policyVersion
      await projectService.addMember(project.id, 'user-bob', 'READER', 'owner-jane');
      const projectAfterAdd = await projectService.getProject(project.id);
      assert.ok(projectAfterAdd);
      assert.notStrictEqual(projectAfterAdd.policyVersion, initialPolicyVersion);

      // Remove member -> rotates project policyVersion
      const v2 = projectAfterAdd.policyVersion;
      await projectService.removeMember(project.id, 'user-bob');
      const projectAfterRemove = await projectService.getProject(project.id);
      assert.ok(projectAfterRemove);
      assert.notStrictEqual(projectAfterRemove.policyVersion, v2);
    });

    it('should rotate resource version when linked TOTP account changes', async () => {
      const totpAcc = await repos.totp.create({
        ownerDiscordUserId: 'user-john',
        accountName: 'google-auth',
        issuer: 'Google',
        secret: 'SECRET',
      });

      const res = await repos.resources.create({
        id: 'res-id',
        name: 'resource-linked',
        mode: 'ONE_OF_N',
        apiKey: 'key',
      });
      assert.ok(res.version);

      // Link TOTP to Resource
      await repos.resources.update(res.id, { totpAccountId: totpAcc.id });
      const resAfterLink = await repos.resources.findById(res.id);
      assert.ok(resAfterLink);
      assert.strictEqual(resAfterLink.totpAccountId, totpAcc.id);
      const v2 = resAfterLink.version;

      // Update TOTP account -> rotates linked resource version
      await repos.totp.update({
        ...totpAcc,
        issuer: 'Google Auth v2',
        updatedAt: new Date(),
      });

      const resAfterTotpUpdate = await repos.resources.findById(res.id);
      assert.ok(resAfterTotpUpdate);
      assert.notStrictEqual(resAfterTotpUpdate.version, v2);
    });
  });
});
