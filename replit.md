# Core Sync Dashboard

## Overview
A Discord bot with web dashboard that tracks "Core Sync" activity in a forum channel and provides visual analytics for member progress.

## Project Structure
- `server.js` - Combined Express web server + Discord bot + PostgreSQL API
- `index.js` - Original Discord bot (standalone)
- `public/index.html` - Dashboard frontend with Chart.js
- `package.json` - Node.js dependencies

## Dependencies
- `discord.js` - Discord API wrapper
- `node-cron` - Scheduled tasks (weekly reports)
- `express` - Web server for dashboard
- `pg` - PostgreSQL database client

## Environment Variables Required
- `BOT_TOKEN` - Discord bot token
- `FORUM_CHANNEL_ID` - ID of the forum channel to scan
- `REPORT_CHANNEL_ID` - ID of the channel to post reports
- `CORE_ROLE_ID` - Role ID for core members to track
- `GUILD_ID` - (Optional) Discord server ID for multi-guild bots
- `DATABASE_URL` - PostgreSQL connection string (auto-configured)

## Running
```bash
npm start    # Dashboard + Bot (server.js)
npm run bot  # Bot only (index.js)
```

## Features
- Web dashboard with real-time sync progress visualization
- Bar chart showing member sync counts
- Progress cards for each Core member with weekly schedule table
- Working time extraction from thread content
- Week navigation (view past weeks)
- **Post-it memo system** - Weekly memos stored in PostgreSQL
- Scans forum threads with format `[YYYY-MM-DD / Name]`
- Generates weekly report (Sundays at 11 AM KST)
- Manual report via `check-report` command in chat

## Database Schema
- `memos` table: id, week_key, content, color, author, position_x, position_y, created_at
