# Sync Bot - Discord Bot

## Overview
A Discord bot that tracks "Core Sync" activity in a forum channel and generates weekly reports for members with a specific role.

## Project Structure
- `index.js` - Main bot file containing all logic
- `package.json` - Node.js dependencies

## Dependencies
- `discord.js` - Discord API wrapper
- `node-cron` - Scheduled tasks (weekly reports)

## Environment Variables Required
- `BOT_TOKEN` - Discord bot token
- `FORUM_CHANNEL_ID` - ID of the forum channel to scan
- `REPORT_CHANNEL_ID` - ID of the channel to post reports
- `CORE_ROLE_ID` - Role ID for core members to track

## Running the Bot
```bash
npm start
```

## Features
- Scans forum threads with format `[YYYY-MM-DD / Name]`
- Counts daily syncs per user per week
- Generates weekly report (Sundays at 11 AM KST)
- Manual report via `check-report` command in chat
