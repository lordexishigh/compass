import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_KINDS,
  ARTIFACT_SCHEMAS,
  findProviderVocabularyViolations,
  providerVocabularyIn,
  tokenizeFieldName,
} from '@compass/connector-port';

describe('provider vocabulary', () => {
  it('splits camelCase, snake_case and kebab-case alike', () => {
    expect(tokenizeFieldName('authorIdentity')).toEqual(['author', 'identity']);
    expect(tokenizeFieldName('source_record_id')).toEqual(['source', 'record', 'id']);
    expect(tokenizeFieldName('merge-revision-id')).toEqual(['merge', 'revision', 'id']);
  });

  it('accepts the neutral vocabulary the port actually uses', () => {
    for (const name of [
      'revisionId',
      'parentRevisionIds',
      'repositoryKey',
      'displayNumber',
      'itemKey',
      'estimatePoints',
      'conversationKey',
      'sourceRecordId',
      'occurredAt',
      'statusCategory',
      'flaggedBlocked',
    ]) {
      expect(providerVocabularyIn(name), `${name} should be provider-neutral`).toBeNull();
    }
  });

  it('rejects the field names a live provider would want to smuggle through', () => {
    expect(providerVocabularyIn('sha')).toBe('sha');
    expect(providerVocabularyIn('headSha')).toBe('sha');
    expect(providerVocabularyIn('issue_number')).toBe('issuenumber');
    expect(providerVocabularyIn('jiraKey')).toBe('jira');
    expect(providerVocabularyIn('slackChannel')).toBe('slack');
    expect(providerVocabularyIn('githubNodeId')).toBe('nodeid');
    expect(providerVocabularyIn('accountId')).toBe('accountid');
    expect(providerVocabularyIn('customfield_10016')).toBe('customfield');
    expect(providerVocabularyIn('storyPoints')).toBe('storypoints');
    expect(providerVocabularyIn('epicLink')).toBe('epiclink');
  });

  it('walks nested objects and arrays and names the offending path', () => {
    const smuggled = {
      records: [{ revisionId: 'abc', author: { accountId: 'jira:123' } }],
    };

    expect(findProviderVocabularyViolations(smuggled)).toEqual([
      { path: '$.records[0].author.accountId', name: 'accountId', term: 'accountid' },
    ]);
  });

  it('finds nothing in a well-formed record', () => {
    expect(
      findProviderVocabularyViolations({
        sourceKey: 'primary-code',
        revisionId: 'a1b2c3d',
        authorIdentity: { kind: 'email', value: 'a@example.com', displayName: 'A' },
        parentRevisionIds: ['ffff'],
      }),
    ).toEqual([]);
  });

  it('holds for every field name declared by every record schema', () => {
    for (const artifact of ARTIFACT_KINDS) {
      const schema = ARTIFACT_SCHEMAS[artifact];
      for (const field of Object.keys(schema.shape)) {
        expect(providerVocabularyIn(field), `${artifact}.${field}`).toBeNull();
      }
    }
  });
});
