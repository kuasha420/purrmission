/**
 * Handler for /purrmission resource commands.
 *
 * Manages resource fields (add, list, get, remove) and 2FA linking.
 */

import {
    SlashCommandSubcommandGroupBuilder,
    type ChatInputCommandInteraction,
    type AutocompleteInteraction,
} from 'discord.js';

import type { CommandContext } from './context.js';
import { logger } from '../../logging/logger.js';
import { env } from '../../config/env.js';
import { generateTOTPCode } from '../../domain/totp.js';
import type { AccessRequestContext, AccessRequestContextWithExtras } from '../../domain/models.js';
import {
    createApprovalButtons,
    createAccessRequestEmbed,
} from '../interactions/approvalButtons.js';
import { rateLimiter } from '../../infra/rateLimit.js';
import { checkAccessPolicy, requiresApproval } from '../../domain/policy.js';

/**
 * Build the 'resource' subcommand group for the /purrmission command.
 */
export function buildResourceSubcommandGroup(): SlashCommandSubcommandGroupBuilder {
    return new SlashCommandSubcommandGroupBuilder()
        .setName('resource')
        .setDescription('Manage resource fields')
        .addSubcommand((subcommand) =>
            subcommand
                .setName('list')
                .setDescription('List all resources you own or represent')
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('fields-add')
                .setDescription('Add a field to a resource')
                .addStringOption((option) =>
                    option
                        .setName('resource-id')
                        .setDescription('ID of the resource')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
                .addStringOption((option) =>
                    option.setName('name').setDescription('Field name (e.g. "password")').setRequired(true)
                )
                .addStringOption((option) =>
                    option.setName('value').setDescription('Field value (will be encrypted)').setRequired(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('fields-list')
                .setDescription('List all fields on a resource')
                .addStringOption((option) =>
                    option
                        .setName('resource-id')
                        .setDescription('ID of the resource')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('fields-get')
                .setDescription('Get a field value from a resource')
                .addStringOption((option) =>
                    option
                        .setName('resource-id')
                        .setDescription('ID of the resource')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
                .addStringOption((option) =>
                    option
                        .setName('name')
                        .setDescription('Field name')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('fields-remove')
                .setDescription('Remove a field from a resource')
                .addStringOption((option) =>
                    option
                        .setName('resource-id')
                        .setDescription('ID of the resource')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
                .addStringOption((option) =>
                    option
                        .setName('name')
                        .setDescription('Field name to remove')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('link-2fa')
                .setDescription('Link a 2FA account to this resource')
                .addStringOption((option) =>
                    option
                        .setName('resource-id')
                        .setDescription('ID of the resource')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
                .addStringOption((option) =>
                    option
                        .setName('account')
                        .setDescription('2FA account name to link')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('unlink-2fa')
                .setDescription('Unlink 2FA account from this resource')
                .addStringOption((option) =>
                    option
                        .setName('resource-id')
                        .setDescription('ID of the resource')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('get-2fa')
                .setDescription('Get the linked 2FA code for this resource')
                .addStringOption((option) =>
                    option
                        .setName('resource-id')
                        .setDescription('ID of the resource')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        );
}

/**
 * Handle /purrmission resource subcommands.
 */
export async function handleResourceCommand(
    interaction: ChatInputCommandInteraction,
    context: CommandContext
): Promise<void> {
    const subcommand = interaction.options.getSubcommand();

    // Only field commands require ENCRYPTION_KEY
    const isFieldCommand = ['fields-add', 'fields-list', 'fields-get', 'fields-remove'].includes(subcommand);
    if (isFieldCommand && !env.ENCRYPTION_KEY) {
        await interaction.reply({
            content: '❌ Resource field commands are disabled. The `ENCRYPTION_KEY` is not configured.',
            ephemeral: true,
        });
        return;
    }

    switch (subcommand) {
        case 'list':
            await handleResourceList(interaction, context);
            break;
        case 'fields-add':
            await handleFieldsAdd(interaction, context);
            break;
        case 'fields-list':
            await handleFieldsList(interaction, context);
            break;
        case 'fields-get':
            await handleFieldsGet(interaction, context);
            break;
        case 'fields-remove':
            await handleFieldsRemove(interaction, context);
            break;
        case 'link-2fa':
            await handleLink2FA(interaction, context);
            break;
        case 'unlink-2fa':
            await handleUnlink2FA(interaction, context);
            break;
        case 'get-2fa':
            await handleGet2FA(interaction, context);
            break;
        default:
            await interaction.reply({
                content: `Unknown subcommand: ${subcommand}`,
                ephemeral: true,
            });
    }
}

/**
 * Handle autocomplete for resource commands.
 */
export async function handleResourceAutocomplete(
    interaction: AutocompleteInteraction,
    context: CommandContext
): Promise<void> {
    const focusedOption = interaction.options.getFocused(true);

    if (focusedOption.name === 'resource-id') {
        const userId = interaction.user.id;
        const { guardians, resources } = context.repositories;

        // Find all resources where the user is a guardian
        const userGuardianships = await guardians.findByUserId(userId);
        const resourceIds = userGuardianships.map((g) => g.resourceId);

        // Fetch resource details optimized
        const validResources = resourceIds.length > 0 ? await resources.findManyByIds(resourceIds) : [];

        // Filter valid resources and match query
        const query = String(focusedOption.value).toLowerCase();
        const filteredResources = validResources
            .filter((r) => r.name.toLowerCase().includes(query));

        await interaction.respond(
            filteredResources.slice(0, 25).map((r) => ({
                name: r.name,
                value: r.id,
            }))
        );
        return;
    }

    if (focusedOption.name === 'name') {
        // Autocomplete field names for the given resource
        const resourceId = interaction.options.getString('resource-id');
        if (!resourceId) {
            await interaction.respond([]);
            return;
        }

        const { resourceFields } = context.repositories;
        const fields = await resourceFields.findByResourceId(resourceId);

        const query = focusedOption.value.toLowerCase();
        const filtered = fields.filter((f) => f.name.toLowerCase().includes(query));

        await interaction.respond(
            filtered.slice(0, 25).map((f) => ({
                name: f.name,
                value: f.name,
            }))
        );
        return;
    }

    if (focusedOption.name === 'account') {
        // Autocomplete TOTP account names for link-2fa command (personal + shared)
        const userId = interaction.user.id;
        const { totp } = context.repositories;

        const personalAccounts = await totp.findByOwnerDiscordUserId(userId);
        const sharedAccounts = await totp.findSharedVisibleTo(userId);

        // Merge and deduplicate accounts
        const accountMap = new Map<string, typeof personalAccounts[0]>();
        personalAccounts.forEach((acc) => accountMap.set(acc.id, acc));
        sharedAccounts.forEach((acc) => {
            if (!accountMap.has(acc.id)) {
                accountMap.set(acc.id, acc);
            }
        });
        const allAccounts = Array.from(accountMap.values());

        const query = focusedOption.value.toLowerCase();
        const filtered = allAccounts.filter((a) => a.accountName.toLowerCase().includes(query));

        await interaction.respond(
            filtered.slice(0, 25).map((a) => ({
                name: a.shared ? `${a.accountName} (shared)` : a.accountName,
                value: a.id,
            }))
        );
        return;
    }

    await interaction.respond([]);
}

/**
 * Check if user is owner/guardian of a resource.
 */
async function isOwnerOrGuardian(
    context: CommandContext,
    resourceId: string,
    discordUserId: string
): Promise<boolean> {
    const { guardians } = context.repositories;
    const guardian = await guardians.findByResourceAndUser(resourceId, discordUserId);
    return guardian !== null;
}

/**
 * Add a field to a resource.
 */
async function handleFieldsAdd(
    interaction: ChatInputCommandInteraction,
    context: CommandContext
): Promise<void> {
    const resourceId = interaction.options.getString('resource-id', true);
    const rawName = interaction.options.getString('name', true);
    const name = rawName.trim();
    const value = interaction.options.getString('value', true);
    const userId = interaction.user.id;

    // Validate field name: 1-64 characters, alphanumeric, hyphens, underscores
    const isValidName =
        name.length > 0 &&
        name.length <= 64 &&
        /^[A-Za-z0-9_-]+$/.test(name);

    if (!isValidName) {
        await interaction.reply({
            content:
                '❌ Invalid field name. Use 1–64 characters: letters, numbers, hyphens, and underscores only.',
            ephemeral: true,
        });
        return;
    }

    // Validate field value length (max 10KB to prevent abuse)
    const MAX_VALUE_LENGTH = 10 * 1024; // 10KB
    if (value.length > MAX_VALUE_LENGTH) {
        await interaction.reply({
            content: `❌ Field value is too long. Maximum length is ${MAX_VALUE_LENGTH} characters.`,
            ephemeral: true,
        });
        return;
    }

    const { resources, resourceFields } = context.repositories;

    // Check resource exists
    const resource = await resources.findById(resourceId);
    if (!resource) {
        await interaction.reply({
            content: '❌ Resource not found.',
            ephemeral: true,
        });
        return;
    }

    // Check user is owner/guardian
    if (!(await isOwnerOrGuardian(context, resourceId, userId))) {
        await interaction.reply({
            content: '❌ You must be an owner or guardian of this resource to add fields.',
            ephemeral: true,
        });
        return;
    }

    // Check if field already exists
    const existing = await resourceFields.findByResourceAndName(resourceId, name);
    if (existing) {
        await interaction.reply({
            content: `❌ A field named \`${name}\` already exists on this resource.`,
            ephemeral: true,
        });
        return;
    }

    try {
        const field = await resourceFields.create({
            resourceId,
            name,
            value,
        });

        logger.info('Resource field created', {
            fieldId: field.id,
            resourceId,
            name,
            userId,
        });

        await interaction.reply({
            content: [
                '✅ **Field added successfully!**',
                '',
                `**Resource:** ${resource.name}`,
                `**Field:** \`${field.name}\``,
                '',
                '_The value is encrypted at rest._',
            ].join('\n'),
            ephemeral: true,
        });
    } catch (error) {
        logger.error('Failed to add resource field', { error });
        await interaction.reply({
            content: '❌ Failed to add field. Please try again.',
            ephemeral: true,
        });
    }
}

/**
 * List all resources where the user is an Owner or Guardian.
 */
async function handleResourceList(
    interaction: ChatInputCommandInteraction,
    context: CommandContext
): Promise<void> {
    const userId = interaction.user.id;
    const { guardians, resources } = context.repositories;

    const userGuardianships = await guardians.findByUserId(userId);

    if (userGuardianships.length === 0) {
        await interaction.reply({
            content: 'You do not own or guard any resources yet.',
            ephemeral: true,
        });
        return;
    }

    const resourceIds = userGuardianships.map((g) => g.resourceId);
    const validResources = await resources.findManyByIds(resourceIds);

    if (validResources.length === 0) {
        // This might happen if guardianships exist but resources were deleted (orphan records)
        // Ideally shouldn't happen with proper cascade delete, but good to handle.
        await interaction.reply({
            content: 'You do not own or guard any resources (orphaned records found).',
            ephemeral: true,
        });
        return;
    }

    // Create a map to look up guardian role for each resource
    const roleMap = new Map<string, string>();
    userGuardianships.forEach(g => {
        roleMap.set(g.resourceId, g.role);
    });

    const lines = [
        '**📋 Your Resources:**',
        '',
        ...validResources.map((r) => {
            const role = roleMap.get(r.id);
            const roleBadge = role === 'OWNER' ? '👑 Owner' : '🛡️ Guardian';
            return `• **${r.name}** (\`${r.id}\`) — ${roleBadge}`;
        }),
    ];

    await interaction.reply({
        content: lines.join('\n'),
        ephemeral: true,
    });
}

/**
 * List all fields on a resource (names only, not values).
 */
async function handleFieldsList(
    interaction: ChatInputCommandInteraction,
    context: CommandContext
): Promise<void> {
    const resourceId = interaction.options.getString('resource-id', true);
    const userId = interaction.user.id;

    const { resources, resourceFields } = context.repositories;

    // Check resource exists
    const resource = await resources.findById(resourceId);
    if (!resource) {
        await interaction.reply({
            content: '❌ Resource not found.',
            ephemeral: true,
        });
        return;
    }

    // Check user is owner/guardian
    if (!(await isOwnerOrGuardian(context, resourceId, userId))) {
        await interaction.reply({
            content: '❌ You must be an owner or guardian of this resource to list fields.',
            ephemeral: true,
        });
        return;
    }

    const fields = await resourceFields.findByResourceId(resourceId);

    if (fields.length === 0) {
        await interaction.reply({
            content: `📭 No fields found on resource **${resource.name}**.`,
            ephemeral: true,
        });
        return;
    }

    const lines = [
        `**📋 Fields on ${resource.name}:**`,
        '',
        ...fields.map((f) => `• \`${f.name}\``),
        '',
        '_Use `/purrmission resource fields-get` to retrieve values._',
    ];

    await interaction.reply({
        content: lines.join('\n'),
        ephemeral: true,
    });
}

/**
 * Get a field value from a resource.
 * Owner/Guardian: Direct access via DM.
 * Non-Guardian: Would trigger approval (Phase 3 - for now, deny).
 */
async function handleFieldsGet(
    interaction: ChatInputCommandInteraction,
    context: CommandContext
): Promise<void> {
    const resourceId = interaction.options.getString('resource-id', true);
    const name = interaction.options.getString('name', true);
    const userId = interaction.user.id;

    const { resources, resourceFields } = context.repositories;

    // Check resource exists
    const resource = await resources.findById(resourceId);
    if (!resource) {
        await interaction.reply({
            content: '❌ Resource not found.',
            ephemeral: true,
        });
        return;
    }

    // Check access policy
    const guardians = await context.repositories.guardians.findByResourceId(resourceId);
    const accessResult = await checkAccessPolicy(resource, guardians, userId);

    if (requiresApproval(accessResult)) {
        // Create approval request for field access
        await createFieldAccessRequest(interaction, context, resource.name, resourceId, name, userId);
        return;
    }

    // Access denied (if not requiring approval, and not allowed)
    if (!accessResult.allowed) {
        await context.services.audit.log({
            action: 'FIELD_ACCESSED',
            resourceId,
            actorId: userId,
            status: 'DENIED',
            context: JSON.stringify({ fieldName: name, reason: accessResult.reason }),
        });

        await interaction.reply({
            content: `❌ Access denied: ${accessResult.reason ?? 'You do not have permission.'}`,
            ephemeral: true,
        });
        return;
    }

    // Direct access allowed
    const field = await resourceFields.findByResourceAndName(resourceId, name);

    if (!field) {
        await interaction.reply({
            content: `❌ Field \`${name}\` not found on this resource.`,
            ephemeral: true,
        });
        return;
    }

    // Send value via DM
    try {
        const dm = await interaction.user.createDM();
        await dm.send(
            [
                `🔐 **Field value for ${resource.name}:**`,
                '',
                `**${field.name}:** \`${field.value}\``,
                '',
                '_Keep this value secure._',
            ].join('\n')
        );

        await context.services.audit.log({
            action: 'FIELD_ACCESSED',
            resourceId,
            actorId: userId,
            status: 'SUCCESS',
            context: JSON.stringify({ fieldName: name }),
        });

        logger.info('Field value sent via DM', {
            resourceId,
            fieldName: name,
            userId,
        });

        await interaction.reply({
            content: '✅ Field value sent to your DMs.',
            ephemeral: true,
        });
    } catch (error) {
        logger.error('Failed to DM field value', { error });
        await interaction.reply({
            content:
                "⚠️ I couldn't send you a DM. Please enable DMs from this server and try again.",
            ephemeral: true,
        });
    }
}

/**
 * Remove a field from a resource.
 */
async function handleFieldsRemove(
    interaction: ChatInputCommandInteraction,
    context: CommandContext
): Promise<void> {
    const resourceId = interaction.options.getString('resource-id', true);
    const name = interaction.options.getString('name', true);
    const userId = interaction.user.id;

    const { resources, resourceFields } = context.repositories;

    // Check resource exists
    const resource = await resources.findById(resourceId);
    if (!resource) {
        await interaction.reply({
            content: '❌ Resource not found.',
            ephemeral: true,
        });
        return;
    }

    // Check user is owner/guardian
    if (!(await isOwnerOrGuardian(context, resourceId, userId))) {
        await interaction.reply({
            content: '❌ You must be an owner or guardian of this resource to remove fields.',
            ephemeral: true,
        });
        return;
    }

    const field = await resourceFields.findByResourceAndName(resourceId, name);
    if (!field) {
        await interaction.reply({
            content: `❌ Field \`${name}\` not found on this resource.`,
            ephemeral: true,
        });
        return;
    }

    try {
        await resourceFields.delete(field.id);

        logger.info('Resource field deleted', {
            fieldId: field.id,
            resourceId,
            name,
            userId,
        });

        await interaction.reply({
            content: [
                '✅ **Field removed successfully!**',
                '',
                `**Resource:** ${resource.name}`,
                `**Field:** \`${name}\``,
            ].join('\n'),
            ephemeral: true,
        });
    } catch (error) {
        logger.error('Failed to remove resource field', { error });
        await interaction.reply({
            content: '❌ Failed to remove field. Please try again.',
            ephemeral: true,
        });
    }
}

/**
 * Link a 2FA account to a resource.
 */
async function handleLink2FA(
    interaction: ChatInputCommandInteraction,
    context: CommandContext
): Promise<void> {
    const resourceId = interaction.options.getString('resource-id', true);
    const accountId = interaction.options.getString('account', true);
    const userId = interaction.user.id;

    const { resources, totp } = context.repositories;

    // Check resource exists
    const resource = await resources.findById(resourceId);
    if (!resource) {
        await interaction.reply({
            content: '❌ Resource not found.',
            ephemeral: true,
        });
        return;
    }

    // Check user is owner/guardian
    if (!(await isOwnerOrGuardian(context, resourceId, userId))) {
        await interaction.reply({
            content: '❌ You must be an owner or guardian of this resource to link 2FA.',
            ephemeral: true,
        });
        return;
    }

    // Find the TOTP account by ID (from autocomplete)
    const account = await totp.findById(accountId);

    if (!account) {
        await interaction.reply({
            content: '❌ 2FA account not found.',
            ephemeral: true,
        });
        return;
    }

    // Verify the user has permission to use this account
    if (account.ownerDiscordUserId !== userId && !account.shared) {
        await interaction.reply({
            content: `❌ You do not have permission to use the 2FA account \`${account.accountName}\`.`,
            ephemeral: true,
        });
        return;
    }

    // Check if resource already has a linked 2FA
    // Note: We'd need to extend ResourceRepository to support linking
    // For now, we'll use a service-level approach via Prisma directly
    // TODO: Add proper repository method for this

    try {
        // Use the services to link
        await context.services.resource.linkTOTPAccount(resourceId, account.id, userId);

        logger.info('Linked 2FA account to resource', {
            resourceId,
            totpAccountId: account.id,
            accountName: account.accountName,
            userId,
        });

        await interaction.reply({
            content: [
                '✅ **2FA account linked successfully!**',
                '',
                `**Resource:** ${resource.name}`,
                `**2FA Account:** ${account.accountName}`,
                '',
                '_Use `/purrmission resource get-2fa` to retrieve codes._',
            ].join('\n'),
            ephemeral: true,
        });
    } catch (error) {
        logger.error('Failed to link 2FA account', { error });
        await interaction.reply({
            content: '❌ Failed to link 2FA account. It may already be linked to another resource.',
            ephemeral: true,
        });
    }
}

/**
 * Unlink 2FA account from a resource.
 */
async function handleUnlink2FA(
    interaction: ChatInputCommandInteraction,
    context: CommandContext
): Promise<void> {
    const resourceId = interaction.options.getString('resource-id', true);
    const userId = interaction.user.id;

    const { resources } = context.repositories;

    // Check resource exists
    const resource = await resources.findById(resourceId);
    if (!resource) {
        await interaction.reply({
            content: '❌ Resource not found.',
            ephemeral: true,
        });
        return;
    }

    // Check user is owner/guardian
    if (!(await isOwnerOrGuardian(context, resourceId, userId))) {
        await interaction.reply({
            content: '❌ You must be an owner or guardian of this resource to unlink 2FA.',
            ephemeral: true,
        });
        return;
    }

    try {
        await context.services.resource.unlinkTOTPAccount(resourceId);

        logger.info('Unlinked 2FA account from resource', {
            resourceId,
            userId,
        });

        await interaction.reply({
            content: [
                '✅ **2FA account unlinked successfully!**',
                '',
                `**Resource:** ${resource.name}`,
            ].join('\n'),
            ephemeral: true,
        });
    } catch (error) {
        logger.error('Failed to unlink 2FA account', { error });
        await interaction.reply({
            content: '❌ Failed to unlink 2FA account. Please try again.',
            ephemeral: true,
        });
    }
}

/**
 * Get the linked 2FA code for a resource.
 * Owner/Guardian: Direct access via DM.
 * Non-Guardian: Would trigger approval (Phase 3 - for now, deny).
 */
async function handleGet2FA(
    interaction: ChatInputCommandInteraction,
    context: CommandContext
): Promise<void> {
    const resourceId = interaction.options.getString('resource-id', true);
    const userId = interaction.user.id;

    const { resources } = context.repositories;

    // Check resource exists
    const resource = await resources.findById(resourceId);
    if (!resource) {
        await interaction.reply({
            content: '❌ Resource not found.',
            ephemeral: true,
        });
        return;
    }

    // Check access policy
    const guardians = await context.repositories.guardians.findByResourceId(resourceId);
    const accessResult = await checkAccessPolicy(resource, guardians, userId);

    if (requiresApproval(accessResult)) {
        // Create approval request for 2FA access
        await create2FAAccessRequest(interaction, context, resource.name, resourceId, userId);
        return;
    }

    // Access denied
    if (!accessResult.allowed) {
        await context.services.audit.log({
            action: 'TOTP_RETRIEVED',
            resourceId,
            actorId: userId,
            status: 'DENIED',
            context: JSON.stringify({ reason: accessResult.reason }),
        });

        await interaction.reply({
            content: `❌ Access denied: ${accessResult.reason ?? 'You do not have permission.'}`,
            ephemeral: true,
        });
        return;
    }

    // Rate limiting
    if (!rateLimiter.check(`${userId}:${resourceId}:get-2fa`)) {
        await interaction.reply({
            content: '❌ Rate limit exceeded. Please wait a few seconds before requesting another code.',
            ephemeral: true,
        });
        return;
    }

    // Get linked TOTP account
    const linkedAccount = await context.services.resource.getLinkedTOTPAccount(resourceId);

    if (!linkedAccount) {
        await interaction.reply({
            content: '❌ No 2FA account is linked to this resource.',
            ephemeral: true,
        });
        return;
    }

    // Generate TOTP code
    const code = generateTOTPCode(linkedAccount);

    // Send via DM
    try {
        const dm = await interaction.user.createDM();
        await dm.send(
            [
                `🔐 **2FA code for ${resource.name}:**`,
                '',
                `**${code}**`,
                '',
                `_Account: ${linkedAccount.accountName}_`,
                '_Code is time-based and will expire soon._',
            ].join('\n')
        );

        logger.info('Sent linked 2FA code via DM', {
            resourceId,
            totpAccountId: linkedAccount.id,
            userId,
        });

        await context.services.audit.log({
            action: 'TOTP_RETRIEVED',
            resourceId,
            actorId: userId,
            status: 'SUCCESS',
            context: JSON.stringify({ totpAccountId: linkedAccount.id }),
        });

        await interaction.reply({
            content: '✅ 2FA code sent to your DMs.',
            ephemeral: true,
        });
    } catch (error) {
        logger.error('Failed to DM 2FA code', { error });
        await interaction.reply({
            content:
                "⚠️ I couldn't send you a DM. Please enable DMs from this server and try again.",
            ephemeral: true,
        });
    }
}

/**
 * Create an approval request for field access and notify guardians.
 */
async function createFieldAccessRequest(
    interaction: ChatInputCommandInteraction,
    context: CommandContext,
    resourceName: string,
    resourceId: string,
    fieldName: string,
    requesterId: string
): Promise<void> {
    const { guardians, resourceFields } = context.repositories;
    const { approval } = context.services;

    // Validate field still exists before creating approval request (prevent race condition)
    const existingField = await resourceFields.findByResourceAndName(resourceId, fieldName);
    if (!existingField) {
        await interaction.reply({
            content: `❌ Field \`${fieldName}\` no longer exists on this resource.`,
            ephemeral: true,
        });
        return;
    }

    // Create approval context
    const accessContext: AccessRequestContext = {
        type: 'FIELD_ACCESS',
        requesterId,
        fieldName,
        description: `Requesting access to field "${fieldName}"`,
    };

    // Create the approval request
    const result = await approval.createApprovalRequest({
        resourceId,
        context: accessContext as AccessRequestContextWithExtras,
        expiresInMs: 15 * 60 * 1000, // 15 minutes
    });

    if (!result.success || !result.request) {
        await interaction.reply({
            content: `❌ Failed to create access request: ${result.error}`,
            ephemeral: true,
        });
        return;
    }

    // Get guardians to notify
    const resourceGuardians = await guardians.findByResourceId(resourceId);

    // Send approval requests to guardians via DM (in parallel)
    const embed = createAccessRequestEmbed(resourceName, accessContext, result.request.expiresAt);
    const buttons = createApprovalButtons(result.request.id);

    const results = await Promise.allSettled(
        resourceGuardians.map(async (guardian) => {
            const user = await interaction.client.users.fetch(guardian.discordUserId);
            const dm = await user.createDM();
            await dm.send({
                embeds: [embed],
                components: [buttons],
            });
            return guardian.discordUserId;
        })
    );

    const notifiedCount = results.filter((r) => r.status === 'fulfilled').length;
    const failedCount = results.filter((r) => r.status === 'rejected').length;

    if (failedCount > 0) {
        logger.warn('Some guardians could not be notified', {
            requestId: result.request.id,
            resourceId,
            notified: notifiedCount,
            failed: failedCount,
        });
    }

    logger.info('Created field access request', {
        requestId: result.request.id,
        resourceId,
        fieldName,
        requesterId,
        notifiedGuardians: notifiedCount,
    });

    if (notifiedCount === 0) {
        await interaction.reply({
            content: '❌ Failed to notify any guardians. They may have DMs disabled or are unreachable.',
            ephemeral: true,
        });
        return;
    }

    await interaction.reply({
        content: [
            '🔔 **Access request sent!**',
            '',
            `Your request for field **${fieldName}** on **${resourceName}** has been sent to ${notifiedCount} guardian(s).`,
            '',
            '_You will receive a DM when a guardian approves or denies your request._',
            `_Request expires in 15 minutes._`,
        ].join('\n'),
        ephemeral: true,
    });
}

/**
 * Create an approval request for 2FA code access and notify guardians.
 */
async function create2FAAccessRequest(
    interaction: ChatInputCommandInteraction,
    context: CommandContext,
    resourceName: string,
    resourceId: string,
    requesterId: string
): Promise<void> {
    const { guardians } = context.repositories;
    const { approval, resource: resourceService } = context.services;

    // Validate TOTP account still linked before creating approval request (prevent race condition)
    const linkedAccount = await resourceService.getLinkedTOTPAccount(resourceId);
    if (!linkedAccount) {
        await interaction.reply({
            content: '❌ No 2FA account is linked to this resource anymore.',
            ephemeral: true,
        });
        return;
    }

    // Create approval context
    const accessContext: AccessRequestContext = {
        type: 'TOTP_ACCESS',
        requesterId,
        description: 'Requesting access to linked 2FA code',
    };

    // Create the approval request
    const result = await approval.createApprovalRequest({
        resourceId,
        context: accessContext as AccessRequestContextWithExtras,
        expiresInMs: 5 * 60 * 1000, // 5 minutes (shorter for TOTP)
    });

    if (!result.success || !result.request) {
        await interaction.reply({
            content: `❌ Failed to create access request: ${result.error}`,
            ephemeral: true,
        });
        return;
    }

    // Get guardians to notify
    const resourceGuardians = await guardians.findByResourceId(resourceId);

    // Send approval requests to guardians via DM (in parallel)
    const embed = createAccessRequestEmbed(resourceName, accessContext, result.request.expiresAt);
    const buttons = createApprovalButtons(result.request.id);

    const results = await Promise.allSettled(
        resourceGuardians.map(async (guardian) => {
            const user = await interaction.client.users.fetch(guardian.discordUserId);
            const dm = await user.createDM();
            await dm.send({
                embeds: [embed],
                components: [buttons],
            });
            return guardian.discordUserId;
        })
    );

    const notifiedCount = results.filter((r) => r.status === 'fulfilled').length;
    const failedCount = results.filter((r) => r.status === 'rejected').length;

    if (failedCount > 0) {
        logger.warn('Some guardians could not be notified', {
            requestId: result.request.id,
            resourceId,
            notified: notifiedCount,
            failed: failedCount,
        });
    }

    logger.info('Created 2FA access request', {
        requestId: result.request.id,
        resourceId,
        requesterId,
        notifiedGuardians: notifiedCount,
    });

    if (notifiedCount === 0) {
        await interaction.reply({
            content: '❌ Failed to notify any guardians. They may have DMs disabled or are unreachable.',
            ephemeral: true,
        });
        return;
    }

    await interaction.reply({
        content: [
            '🔔 **Access request sent!**',
            '',
            `Your request for 2FA code on **${resourceName}** has been sent to ${notifiedCount} guardian(s).`,
            '',
            '_You will receive a DM when a guardian approves or denies your request._',
            `_Request expires in 5 minutes (TOTP codes are time-sensitive)._`,
        ].join('\n'),
        ephemeral: true,
    });
}
