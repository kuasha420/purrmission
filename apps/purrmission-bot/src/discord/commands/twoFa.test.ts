import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  twoFaCommand,
  handle2FACommand,
  handleTwoFaAutocomplete,
  handle2FAAutocomplete,
  handleAdd2FA,
  handleList2FA,
  handleGet2FA,
  handleUpdate2FA,
  data,
  execute,
  autocomplete,
} from './twoFa.js';
import type { CommandContext } from './context.js';
import type { TOTPAccount } from '../../domain/models.js';
import type { TOTPRepository } from '../../domain/repositories.js';
import type { AuditService } from '../../domain/audit.js';
import { rateLimiter } from '../../infra/rateLimit.js';

interface ReplyOptions {
  content: string;
  ephemeral?: boolean;
}

interface ChoiceOption {
  name: string;
  value: string;
}

describe('twoFa command module', () => {
  let mockInteraction: {
    user: {
      id: string;
      createDM: ReturnType<typeof mock.fn>;
    };
    options: {
      getSubcommand: ReturnType<typeof mock.fn>;
      getString: ReturnType<typeof mock.fn>;
      getBoolean: ReturnType<typeof mock.fn>;
      getAttachment: ReturnType<typeof mock.fn>;
      getFocused: ReturnType<typeof mock.fn>;
    };
    reply: ReturnType<typeof mock.fn>;
    respond: ReturnType<typeof mock.fn>;
  };

  let mockContext: CommandContext;
  let mockTotpRepository: {
    create: ReturnType<typeof mock.fn>;
    findByOwnerDiscordUserId: ReturnType<typeof mock.fn>;
    findSharedVisibleTo: ReturnType<typeof mock.fn>;
    findByOwnerAndName: ReturnType<typeof mock.fn>;
    update: ReturnType<typeof mock.fn>;
  };
  let mockAuditService: {
    log: ReturnType<typeof mock.fn>;
  };
  let replyCalls: ReplyOptions[];
  let dmSendCalls: string[];

  beforeEach(() => {
    replyCalls = [];
    dmSendCalls = [];

    mockTotpRepository = {
      create: mock.fn(
        async (accountData: {
          ownerDiscordUserId: string;
          accountName: string;
          secret: string;
          issuer?: string;
          shared?: boolean;
        }) => ({
          id: 'totp-1',
          ownerDiscordUserId: accountData.ownerDiscordUserId,
          accountName: accountData.accountName,
          secret: accountData.secret,
          issuer: accountData.issuer,
          shared: accountData.shared ?? false,
          backupKey: undefined,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
      ),
      findByOwnerDiscordUserId: mock.fn(async (_userId: string) => []),
      findSharedVisibleTo: mock.fn(async (_userId: string) => []),
      findByOwnerAndName: mock.fn(async (_userId: string, _name: string) => null),
      update: mock.fn(async (account: TOTPAccount) => account),
    };

    mockAuditService = {
      log: mock.fn(async () => {}),
    };

    mockContext = {
      repositories: {
        totp: mockTotpRepository as unknown as TOTPRepository,
      } as unknown as CommandContext['repositories'],
      services: {
        audit: mockAuditService as unknown as AuditService,
      } as unknown as CommandContext['services'],
    };

    mockInteraction = {
      user: {
        id: 'user-123',
        createDM: mock.fn(async () => ({
          send: mock.fn(async (content: string) => {
            dmSendCalls.push(content);
          }),
        })),
      },
      options: {
        getSubcommand: mock.fn(() => 'add'),
        getString: mock.fn((_name: string) => null),
        getBoolean: mock.fn((_name: string) => null),
        getAttachment: mock.fn((_name: string) => null),
        getFocused: mock.fn(() => ({ name: 'account', value: '' })),
      },
      reply: mock.fn(async (options: ReplyOptions) => {
        replyCalls.push(options);
      }),
      respond: mock.fn(async (_choices: ChoiceOption[]) => {}),
    };
  });

  describe('Builder Definition', () => {
    it('should have correct name and description', () => {
      assert.equal(twoFaCommand.name, '2fa');
      assert.equal(twoFaCommand.description, 'Manage 2FA accounts');
      assert.equal(data.name, '2fa');
    });

    it('should register add, list, get, update subcommands with uri option on add', () => {
      const json = twoFaCommand.toJSON();
      assert.equal(json.options?.length, 4);

      const addSub = json.options?.find((opt) => opt.name === 'add');
      assert.ok(addSub);
      const subOptions = (addSub as { options?: { name: string }[] }).options;
      const uriOpt = subOptions?.find((opt) => opt.name === 'uri');
      assert.ok(uriOpt, 'uri option should be present on add subcommand');
    });
  });

  describe('Router (handle2FACommand / execute)', () => {
    it('should delegate to handleAdd2FA for add subcommand', async () => {
      mockInteraction.options.getSubcommand = mock.fn(() => 'add');
      mockInteraction.options.getString = mock.fn((name: string) => {
        if (name === 'account') return 'Google';
        if (name === 'mode') return 'secret';
        if (name === 'secret') return 'JBSWY3DPEHPK3PXP';
        return null;
      });

      await handle2FACommand(
        mockInteraction as unknown as Parameters<typeof handle2FACommand>[0],
        mockContext
      );
      assert.equal(mockTotpRepository.create.mock.callCount(), 1);
    });

    it('should delegate via execute alias', async () => {
      mockInteraction.options.getSubcommand = mock.fn(() => 'add');
      mockInteraction.options.getString = mock.fn((name: string) => {
        if (name === 'account') return 'Google';
        if (name === 'mode') return 'secret';
        if (name === 'secret') return 'JBSWY3DPEHPK3PXP';
        return null;
      });

      await execute(mockInteraction as unknown as Parameters<typeof execute>[0], mockContext);
      assert.equal(mockTotpRepository.create.mock.callCount(), 1);
    });

    it('should handle unknown subcommand', async () => {
      mockInteraction.options.getSubcommand = mock.fn(() => 'unknown_sub');

      await handle2FACommand(
        mockInteraction as unknown as Parameters<typeof handle2FACommand>[0],
        mockContext
      );
      assert.equal(replyCalls.length, 1);
      assert.equal(replyCalls[0].content, 'Unknown subcommand: unknown_sub');
      assert.equal(replyCalls[0].ephemeral, true);
    });
  });

  describe('handleAdd2FA', () => {
    it('should add account via URI mode', async () => {
      mockInteraction.options.getString = mock.fn((name: string) => {
        if (name === 'account') return 'GitHub';
        if (name === 'mode') return 'uri';
        if (name === 'uri')
          return 'otpauth://totp/GitHub:user?secret=JBSWY3DPEHPK3PXP&issuer=GitHub';
        return null;
      });

      await handleAdd2FA(
        mockInteraction as unknown as Parameters<typeof handleAdd2FA>[0],
        mockContext
      );
      assert.equal(mockTotpRepository.create.mock.callCount(), 1);
      assert.equal(replyCalls[0].ephemeral, true);
      assert.match(replyCalls[0].content, /GitHub/);
    });

    it('should fail URI mode if uri string missing', async () => {
      mockInteraction.options.getString = mock.fn((name: string) => {
        if (name === 'account') return 'GitHub';
        if (name === 'mode') return 'uri';
        return null;
      });

      await handleAdd2FA(
        mockInteraction as unknown as Parameters<typeof handleAdd2FA>[0],
        mockContext
      );
      assert.equal(
        replyCalls[0].content,
        '❌ You selected mode `uri` but did not provide a `uri` value.'
      );
    });

    it('should add account via Secret mode with optional issuer and shared', async () => {
      mockInteraction.options.getString = mock.fn((name: string) => {
        if (name === 'account') return 'AWS';
        if (name === 'mode') return 'secret';
        if (name === 'secret') return 'JBSWY3DPEHPK3PXP';
        if (name === 'issuer') return 'Amazon';
        return null;
      });
      mockInteraction.options.getBoolean = mock.fn((name: string) =>
        name === 'shared' ? true : null
      );

      await handleAdd2FA(
        mockInteraction as unknown as Parameters<typeof handleAdd2FA>[0],
        mockContext
      );
      assert.equal(mockTotpRepository.create.mock.callCount(), 1);
      assert.match(replyCalls[0].content, /marked as \*\*shared\*\*/);
    });

    it('should fail secret mode if secret missing', async () => {
      mockInteraction.options.getString = mock.fn((name: string) => {
        if (name === 'account') return 'AWS';
        if (name === 'mode') return 'secret';
        return null;
      });

      await handleAdd2FA(
        mockInteraction as unknown as Parameters<typeof handleAdd2FA>[0],
        mockContext
      );
      assert.equal(
        replyCalls[0].content,
        '❌ You selected mode `secret` but did not provide a `secret` value.'
      );
    });

    it('should handle QR mode stub', async () => {
      mockInteraction.options.getString = mock.fn((name: string) => {
        if (name === 'account') return 'Test';
        if (name === 'mode') return 'qr';
        return null;
      });

      await handleAdd2FA(
        mockInteraction as unknown as Parameters<typeof handleAdd2FA>[0],
        mockContext
      );
      assert.match(replyCalls[0].content, /QR mode is not implemented yet/);
    });

    it('should handle unsupported mode', async () => {
      mockInteraction.options.getString = mock.fn((name: string) => {
        if (name === 'account') return 'Test';
        if (name === 'mode') return 'invalid';
        return null;
      });

      await handleAdd2FA(
        mockInteraction as unknown as Parameters<typeof handleAdd2FA>[0],
        mockContext
      );
      assert.match(replyCalls[0].content, /Unsupported mode/);
    });

    it('should catch error if creation throws', async () => {
      mockTotpRepository.create = mock.fn(async () => {
        throw new Error('Database connection failed');
      });

      mockInteraction.options.getString = mock.fn((name: string) => {
        if (name === 'account') return 'Test';
        if (name === 'mode') return 'secret';
        if (name === 'secret') return 'JBSWY3DPEHPK3PXP';
        return null;
      });

      await handleAdd2FA(
        mockInteraction as unknown as Parameters<typeof handleAdd2FA>[0],
        mockContext
      );
      assert.match(replyCalls[0].content, /Failed to add 2FA account/);
    });
  });

  describe('handleList2FA', () => {
    it('should list personal accounts', async () => {
      mockTotpRepository.findByOwnerDiscordUserId = mock.fn(async () => [
        { accountName: 'Google', shared: false },
        { accountName: 'AWS', shared: true },
      ]);

      await handleList2FA(
        mockInteraction as unknown as Parameters<typeof handleList2FA>[0],
        mockContext
      );
      assert.match(replyCalls[0].content, /Your 2FA accounts/);
      assert.match(replyCalls[0].content, /Google/);
      assert.match(replyCalls[0].content, /AWS \(shared\)/);
    });

    it('should list shared accounts visible to user', async () => {
      mockTotpRepository.findByOwnerDiscordUserId = mock.fn(async () => [
        { ownerDiscordUserId: 'user-123', accountName: 'Google', shared: false },
      ]);
      mockTotpRepository.findSharedVisibleTo = mock.fn(async () => [
        { ownerDiscordUserId: 'user-999', accountName: 'Team-VPN', shared: true },
        { ownerDiscordUserId: 'user-123', accountName: 'Google', shared: false },
      ]);

      mockInteraction.options.getBoolean = mock.fn((name: string) =>
        name === 'shared' ? true : null
      );

      await handleList2FA(
        mockInteraction as unknown as Parameters<typeof handleList2FA>[0],
        mockContext
      );
      assert.match(replyCalls[0].content, /Your 2FA accounts/);
      assert.match(replyCalls[0].content, /Shared accounts visible to you/);
      assert.match(replyCalls[0].content, /Team-VPN/);
    });

    it('should handle zero accounts', async () => {
      await handleList2FA(
        mockInteraction as unknown as Parameters<typeof handleList2FA>[0],
        mockContext
      );
      assert.equal(replyCalls[0].content, "You don't have any 2FA accounts yet.");
    });
  });

  describe('handleGet2FA', () => {
    it('should enforce rate limits', async () => {
      mockInteraction.options.getString = mock.fn((name: string) =>
        name === 'account' ? 'Google' : null
      );
      mock.method(rateLimiter, 'check', () => false);

      await handleGet2FA(
        mockInteraction as unknown as Parameters<typeof handleGet2FA>[0],
        mockContext
      );
      assert.match(replyCalls[0].content, /too quickly/);
      assert.equal(mockAuditService.log.mock.callCount(), 1);
    });

    it('should return error if account not found', async () => {
      mockInteraction.options.getString = mock.fn((name: string) =>
        name === 'account' ? 'NonExistent' : null
      );
      mock.method(rateLimiter, 'check', () => true);

      await handleGet2FA(
        mockInteraction as unknown as Parameters<typeof handleGet2FA>[0],
        mockContext
      );
      assert.match(replyCalls[0].content, /No matching 2FA account found/);
    });

    it('should get backup key and DM to user', async () => {
      mockInteraction.options.getString = mock.fn((name: string) =>
        name === 'account' ? 'Google' : null
      );
      mockInteraction.options.getBoolean = mock.fn((name: string) =>
        name === 'backup' ? true : null
      );
      mock.method(rateLimiter, 'check', () => true);

      const fakeAccount: TOTPAccount = {
        id: 'totp-1',
        ownerDiscordUserId: 'user-123',
        accountName: 'Google',
        secret: 'JBSWY3DPEHPK3PXP',
        shared: false,
        backupKey: 'BACKUP-1234',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockTotpRepository.findByOwnerAndName = mock.fn(async () => fakeAccount);

      await handleGet2FA(
        mockInteraction as unknown as Parameters<typeof handleGet2FA>[0],
        mockContext
      );
      assert.equal(dmSendCalls.length, 1);
      assert.match(dmSendCalls[0], /BACKUP-1234/);
      assert.match(replyCalls[0].content, /Backup key sent to your DMs/);
    });

    it('should reply error if backup key is requested but missing', async () => {
      mockInteraction.options.getString = mock.fn((name: string) =>
        name === 'account' ? 'Google' : null
      );
      mockInteraction.options.getBoolean = mock.fn((name: string) =>
        name === 'backup' ? true : null
      );
      mock.method(rateLimiter, 'check', () => true);

      const fakeAccount: TOTPAccount = {
        id: 'totp-1',
        ownerDiscordUserId: 'user-123',
        accountName: 'Google',
        secret: 'JBSWY3DPEHPK3PXP',
        shared: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockTotpRepository.findByOwnerAndName = mock.fn(async () => fakeAccount);

      await handleGet2FA(
        mockInteraction as unknown as Parameters<typeof handleGet2FA>[0],
        mockContext
      );
      assert.match(replyCalls[0].content, /No backup key found for/);
    });

    it('should handle DM failure gracefully', async () => {
      mockInteraction.options.getString = mock.fn((name: string) =>
        name === 'account' ? 'Google' : null
      );
      mockInteraction.options.getBoolean = mock.fn((name: string) =>
        name === 'backup' ? true : null
      );
      mock.method(rateLimiter, 'check', () => true);

      mockInteraction.user.createDM = mock.fn(async () => {
        throw new Error('DMs disabled');
      });

      const fakeAccount: TOTPAccount = {
        id: 'totp-1',
        ownerDiscordUserId: 'user-123',
        accountName: 'Google',
        secret: 'JBSWY3DPEHPK3PXP',
        shared: false,
        backupKey: 'BACKUP-KEY',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockTotpRepository.findByOwnerAndName = mock.fn(async () => fakeAccount);

      await handleGet2FA(
        mockInteraction as unknown as Parameters<typeof handleGet2FA>[0],
        mockContext
      );
      assert.match(replyCalls[0].content, /couldn't send you a DM/);
    });
  });

  describe('handleUpdate2FA', () => {
    it('should return error if account not found', async () => {
      mockInteraction.options.getString = mock.fn((name: string) => {
        if (name === 'account') return 'NonExistent';
        if (name === 'backup_key') return 'NEW-KEY';
        return null;
      });

      await handleUpdate2FA(
        mockInteraction as unknown as Parameters<typeof handleUpdate2FA>[0],
        mockContext
      );
      assert.equal(replyCalls[0].content, '❌ Account not found.');
    });

    it('should return error if requester is not owner', async () => {
      mockInteraction.options.getString = mock.fn((name: string) => {
        if (name === 'account') return 'TeamAccount';
        if (name === 'backup_key') return 'NEW-KEY';
        return null;
      });

      const fakeAccount: TOTPAccount = {
        id: 'totp-1',
        ownerDiscordUserId: 'other-user',
        accountName: 'TeamAccount',
        secret: 'JBSWY3DPEHPK3PXP',
        shared: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockTotpRepository.findSharedVisibleTo = mock.fn(async () => [fakeAccount]);

      await handleUpdate2FA(
        mockInteraction as unknown as Parameters<typeof handleUpdate2FA>[0],
        mockContext
      );
      assert.match(replyCalls[0].content, /not the owner/);
    });

    it('should update backup key successfully if requester is owner', async () => {
      mockInteraction.options.getString = mock.fn((name: string) => {
        if (name === 'account') return 'MyAccount';
        if (name === 'backup_key') return 'NEW-KEY-123';
        return null;
      });

      const fakeAccount: TOTPAccount = {
        id: 'totp-1',
        ownerDiscordUserId: 'user-123',
        accountName: 'MyAccount',
        secret: 'JBSWY3DPEHPK3PXP',
        shared: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockTotpRepository.findByOwnerAndName = mock.fn(async () => fakeAccount);

      await handleUpdate2FA(
        mockInteraction as unknown as Parameters<typeof handleUpdate2FA>[0],
        mockContext
      );
      assert.equal(mockTotpRepository.update.mock.callCount(), 1);
      assert.equal(fakeAccount.backupKey, 'NEW-KEY-123');
      assert.match(replyCalls[0].content, /Backup key updated successfully/);
    });
  });

  describe('Autocomplete (handleTwoFaAutocomplete / handle2FAAutocomplete / autocomplete)', () => {
    it('should return early if subcommand is not get or update', async () => {
      mockInteraction.options.getSubcommand = mock.fn(() => 'add');

      await handleTwoFaAutocomplete(
        mockInteraction as unknown as Parameters<typeof handleTwoFaAutocomplete>[0],
        mockContext
      );
      assert.equal(mockInteraction.respond.mock.callCount(), 0);
    });

    it('should return early if focused option is not account', async () => {
      mockInteraction.options.getSubcommand = mock.fn(() => 'get');
      mockInteraction.options.getFocused = mock.fn(() => ({ name: 'other', value: '' }));

      await handleTwoFaAutocomplete(
        mockInteraction as unknown as Parameters<typeof handleTwoFaAutocomplete>[0],
        mockContext
      );
      assert.equal(mockInteraction.respond.mock.callCount(), 0);
    });

    it('should respond with matching account choices deduplicated (personal first)', async () => {
      mockInteraction.options.getSubcommand = mock.fn(() => 'get');
      mockInteraction.options.getFocused = mock.fn(() => ({ name: 'account', value: 'goog' }));

      mockTotpRepository.findByOwnerDiscordUserId = mock.fn(async () => [
        { accountName: 'Google-Personal' },
      ]);
      mockTotpRepository.findSharedVisibleTo = mock.fn(async () => [
        { accountName: 'Google-Shared' },
        { accountName: 'AWS' },
      ]);

      await handleTwoFaAutocomplete(
        mockInteraction as unknown as Parameters<typeof handleTwoFaAutocomplete>[0],
        mockContext
      );
      assert.equal(mockInteraction.respond.mock.callCount(), 1);

      const choices = mockInteraction.respond.mock.calls[0].arguments[0] as ChoiceOption[];
      assert.equal(choices.length, 2);
      assert.equal(choices[0].name, 'Google-Personal');
      assert.equal(choices[1].name, 'Google-Shared');
    });

    it('should test autocomplete alias function exports', async () => {
      mockInteraction.options.getSubcommand = mock.fn(() => 'add');
      await handle2FAAutocomplete(
        mockInteraction as unknown as Parameters<typeof handle2FAAutocomplete>[0],
        mockContext
      );
      await autocomplete(
        mockInteraction as unknown as Parameters<typeof autocomplete>[0],
        mockContext
      );
      assert.equal(mockInteraction.respond.mock.callCount(), 0);
    });
  });
});
