# daeng_discord

## Jira AI review webhook

`POST /webhooks/jira/ai-review` receives configured Jira status transitions, reviews linked Jira/Notion/Figma evidence with the OpenAI Responses API, posts the result directly to Jira, and sends a summary to Discord.

Required Railway variables:

- `JIRA_BASE_URL`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`
- `JIRA_REVIEW_WEBHOOK_SECRET`
- `OPENAI_API_KEY`

Review scope and integrations:

- `JIRA_REVIEW_SPRINT_ID` — defaults to `338`
- `JIRA_SPRINT_FIELD` — defaults to `customfield_10020`
- `OPENAI_MODEL` — defaults to `gpt-5.6-terra`
- `NOTION_TOKEN` — required when a review needs a Notion PRD
- `FIGMA_ACCESS_TOKEN` — required when a review needs Figma
- `REVIEW_DISCORD_WEBHOOK_URL` — falls back to `DISCORD_WEBHOOK_URL`
- `DISCORD_PLANNING_ROLE_ID`
- `DISCORD_DEVELOPMENT_ROLE_ID`

Jira Automation must send JSON in this shape and include the shared secret in the `x-jira-webhook-secret` header:

```json
{
  "issueKey": "{{issue.key}}",
  "issueType": "{{issue.issueType.name}}",
  "summary": "{{issue.summary}}",
  "fromStatus": "{{changelog.status.fromString}}",
  "toStatus": "{{changelog.status.toString}}",
  "updatedAt": "{{issue.updated}}",
  "sprintId": 338
}
```

The endpoint queues accepted events in PostgreSQL before returning `202`. Duplicate event keys are ignored, and failed jobs are retried up to three times. Before posting the Jira comment, Discord receives an `in progress` notification; after Jira succeeds, that same Discord message is updated to `completed`.

`GET /api/jira-review/health` returns integration readiness and queue counts when called with the same secret header. It never returns credential values.
