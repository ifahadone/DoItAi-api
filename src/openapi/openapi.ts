/**
 * OpenAPI 3.1 document generated FROM the Zod contract (ApiSpec §3 — "the same
 * schemas generate the OpenAPI 3.1 doc"). The contract in src/contract/schemas.ts
 * is the single source of truth; here we convert those schemas to JSON Schema
 * with `zod-to-json-schema` and assemble the paths.
 *
 * Served at GET /api/v1/openapi.json (registered in src/app.ts, unauthenticated).
 * This is a Phase-0 baseline covering auth + sync + the task/list/tag CRUD; it
 * grows additively with the contract.
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import {
  TaskSchema,
  TaskCreateSchema,
  TaskPatchSchema,
  TaskListSchema,
  TaskListCreateSchema,
  TaskListPatchSchema,
  TagSchema,
  TagCreateSchema,
  TagPatchSchema,
  RecurrenceRuleSchema,
  LocationSchema,
  AppleSignInSchema,
  RefreshSchema,
  LogoutSchema,
  TokenPairSchema,
  SyncPushRequestSchema,
  SyncPushResponseSchema,
  SyncPullResponseSchema,
} from '@/contract/schemas.js';

const COMPONENTS = '#/components/schemas';

function def(schema: z.ZodTypeAny, name: string): Record<string, unknown> {
  // `target: openApi3` keeps output compatible with the OpenAPI dialect; we
  // strip the top-level $schema and reuse internal refs against our components.
  const json = zodToJsonSchema(schema, {
    name,
    target: 'openApi3',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  // zod-to-json-schema wraps named output under definitions[name]; unwrap it.
  const defs = (json['definitions'] ?? {}) as Record<string, unknown>;
  return (defs[name] as Record<string, unknown>) ?? json;
}

const errorEnvelope = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      properties: {
        code: {
          type: 'string',
          enum: [
            'validation_error',
            'unauthenticated',
            'forbidden',
            'not_found',
            'conflict',
            'gone',
            'ai_consent_required',
            'ai_budget_exceeded',
            'rate_limited',
            'internal',
          ],
        },
        message: { type: 'string' },
        details: {},
        requestId: { type: 'string' },
      },
    },
  },
} as const;

const jsonBody = (ref: string) => ({
  required: true,
  content: { 'application/json': { schema: { $ref: `${COMPONENTS}/${ref}` } } },
});
const jsonResp = (ref: string, description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: `${COMPONENTS}/${ref}` } } },
});
const errorResp = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: `${COMPONENTS}/ErrorEnvelope` } } },
});

/** Build (once) and return the OpenAPI document object. */
let cached: Record<string, unknown> | null = null;

export function buildOpenApiDocument(): Record<string, unknown> {
  if (cached) return cached;

  const schemas: Record<string, unknown> = {
    ErrorEnvelope: errorEnvelope,
    Task: def(TaskSchema, 'Task'),
    TaskCreate: def(TaskCreateSchema, 'TaskCreate'),
    TaskPatch: def(TaskPatchSchema, 'TaskPatch'),
    TaskList: def(TaskListSchema, 'TaskList'),
    TaskListCreate: def(TaskListCreateSchema, 'TaskListCreate'),
    TaskListPatch: def(TaskListPatchSchema, 'TaskListPatch'),
    Tag: def(TagSchema, 'Tag'),
    TagCreate: def(TagCreateSchema, 'TagCreate'),
    TagPatch: def(TagPatchSchema, 'TagPatch'),
    RecurrenceRule: def(RecurrenceRuleSchema, 'RecurrenceRule'),
    Location: def(LocationSchema, 'Location'),
    AppleSignIn: def(AppleSignInSchema, 'AppleSignIn'),
    RefreshRequest: def(RefreshSchema, 'RefreshRequest'),
    LogoutRequest: def(LogoutSchema, 'LogoutRequest'),
    TokenPair: def(TokenPairSchema, 'TokenPair'),
    SyncPushRequest: def(SyncPushRequestSchema, 'SyncPushRequest'),
    SyncPushResponse: def(SyncPushResponseSchema, 'SyncPushResponse'),
    SyncPullResponse: def(SyncPullResponseSchema, 'SyncPullResponse'),
  };

  const bearer = [{ bearerAuth: [] }];

  cached = {
    openapi: '3.1.0',
    info: {
      title: 'DoIT API',
      version: '0.1.0',
      description:
        'DoIT backend — Phase 0 surface: Sign in with Apple auth, offline sync (push/pull), and task/list/tag CRUD. Generated from the Zod contract.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas,
    },
    paths: {
      '/auth/apple': {
        post: {
          tags: ['auth'],
          summary: 'Exchange an Apple identity token for our tokens',
          security: [],
          requestBody: jsonBody('AppleSignIn'),
          responses: {
            200: jsonResp('TokenPair', 'Authenticated'),
            400: errorResp('Validation error'),
            401: errorResp('Apple token verification failed'),
          },
        },
      },
      '/auth/refresh': {
        post: {
          tags: ['auth'],
          summary: 'Rotate access + refresh tokens',
          security: [],
          requestBody: jsonBody('RefreshRequest'),
          responses: {
            200: jsonResp('TokenPair', 'Rotated'),
            401: errorResp('Invalid/expired/reused refresh token'),
          },
        },
      },
      '/auth/logout': {
        post: {
          tags: ['auth'],
          summary: 'Revoke this device’s refresh token',
          security: [],
          requestBody: jsonBody('LogoutRequest'),
          responses: { 204: { description: 'Logged out' } },
        },
      },
      '/sync/push': {
        post: {
          tags: ['sync'],
          summary: 'Push a batch of client mutations',
          security: bearer,
          requestBody: jsonBody('SyncPushRequest'),
          responses: {
            200: jsonResp('SyncPushResponse', 'Per-op results, in request order'),
            400: errorResp('Validation error'),
            401: errorResp('Unauthenticated'),
          },
        },
      },
      '/sync/pull': {
        get: {
          tags: ['sync'],
          summary: 'Pull deltas since a cursor',
          security: bearer,
          parameters: [
            { name: 'cursor', in: 'query', schema: { type: 'string' }, required: false },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', maximum: 500, default: 500 },
              required: false,
            },
          ],
          responses: {
            200: jsonResp('SyncPullResponse', 'Changes + nextCursor'),
            401: errorResp('Unauthenticated'),
          },
        },
      },
      '/tasks': {
        get: {
          tags: ['tasks'],
          summary: 'List owned tasks',
          security: bearer,
          responses: { 200: { description: 'Task collection' }, 401: errorResp('Unauthenticated') },
        },
        post: {
          tags: ['tasks'],
          summary: 'Create a task (client-supplied id)',
          security: bearer,
          requestBody: jsonBody('TaskCreate'),
          responses: {
            201: jsonResp('Task', 'Created'),
            400: errorResp('Validation error'),
            409: errorResp('Conflict'),
          },
        },
      },
      '/tasks/{id}': {
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        get: {
          tags: ['tasks'],
          summary: 'Get a task',
          security: bearer,
          responses: { 200: jsonResp('Task', 'OK'), 404: errorResp('Not found') },
        },
        patch: {
          tags: ['tasks'],
          summary: 'Update a task',
          security: bearer,
          requestBody: jsonBody('TaskPatch'),
          responses: {
            200: jsonResp('Task', 'OK'),
            404: errorResp('Not found'),
            409: errorResp('Conflict'),
          },
        },
        delete: {
          tags: ['tasks'],
          summary: 'Soft-delete a task',
          security: bearer,
          responses: { 204: { description: 'Deleted' }, 404: errorResp('Not found') },
        },
      },
      '/lists': {
        get: { tags: ['lists'], summary: 'List lists', security: bearer, responses: { 200: { description: 'OK' } } },
        post: {
          tags: ['lists'],
          summary: 'Create a list',
          security: bearer,
          requestBody: jsonBody('TaskListCreate'),
          responses: { 201: jsonResp('TaskList', 'Created') },
        },
      },
      '/lists/{id}': {
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        get: { tags: ['lists'], summary: 'Get a list', security: bearer, responses: { 200: jsonResp('TaskList', 'OK'), 404: errorResp('Not found') } },
        patch: {
          tags: ['lists'],
          summary: 'Update a list',
          security: bearer,
          requestBody: jsonBody('TaskListPatch'),
          responses: { 200: jsonResp('TaskList', 'OK'), 404: errorResp('Not found') },
        },
        delete: { tags: ['lists'], summary: 'Delete a list', security: bearer, responses: { 204: { description: 'Deleted' } } },
      },
      '/tags': {
        get: { tags: ['tags'], summary: 'List tags', security: bearer, responses: { 200: { description: 'OK' } } },
        post: {
          tags: ['tags'],
          summary: 'Create a tag',
          security: bearer,
          requestBody: jsonBody('TagCreate'),
          responses: { 201: jsonResp('Tag', 'Created') },
        },
      },
      '/tags/{id}': {
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        patch: {
          tags: ['tags'],
          summary: 'Update a tag',
          security: bearer,
          requestBody: jsonBody('TagPatch'),
          responses: { 200: jsonResp('Tag', 'OK'), 404: errorResp('Not found') },
        },
        delete: { tags: ['tags'], summary: 'Delete a tag', security: bearer, responses: { 204: { description: 'Deleted' } } },
      },
      '/health': {
        get: { tags: ['ops'], summary: 'Liveness', security: [], responses: { 200: { description: 'Alive' } } },
      },
      '/ready': {
        get: { tags: ['ops'], summary: 'Readiness', security: [], responses: { 200: { description: 'Ready' }, 503: { description: 'Not ready' } } },
      },
    },
  };

  return cached;
}
