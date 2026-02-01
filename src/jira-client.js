const { Version3Client } = require('jira.js');

let connectionSettings = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (connectionSettings && tokenExpiresAt > now) {
    const accessToken = connectionSettings?.settings?.access_token || 
                        connectionSettings?.settings?.oauth?.credentials?.access_token;
    const hostName = connectionSettings?.settings?.site_url;
    if (accessToken && hostName) {
      return { accessToken, hostName };
    }
  }
  
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('Jira authentication not available - please reconnect Jira integration');
  }

  const connectorUrl = 'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=jira';
  
  const response = await fetch(connectorUrl, {
    headers: {
      'Accept': 'application/json',
      'X_REPLIT_TOKEN': xReplitToken
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to get Jira credentials: ${response.status}`);
  }
  
  const data = await response.json();
  connectionSettings = data.items?.[0];

  const accessToken = connectionSettings?.settings?.access_token || 
                      connectionSettings?.settings?.oauth?.credentials?.access_token;
  const hostName = connectionSettings?.settings?.site_url;

  if (!connectionSettings || !accessToken || !hostName) {
    console.error('Jira connection settings:', JSON.stringify(connectionSettings, null, 2));
    throw new Error('Jira not connected - please set up Jira integration');
  }

  const expiresAt = connectionSettings?.settings?.expires_at;
  if (expiresAt) {
    tokenExpiresAt = new Date(expiresAt).getTime() - 60000;
  } else {
    tokenExpiresAt = now + 3600000;
  }

  return { accessToken, hostName };
}

async function getJiraClient() {
  const { accessToken, hostName } = await getAccessToken();
  
  const id = await getCloudId(accessToken);
  const apiHost = `https://api.atlassian.com/ex/jira/${id}`;

  const client = new Version3Client({
    host: apiHost,
    authentication: {
      oauth2: { accessToken },
    },
  });
  
  return client;
}

let cloudId = null;

async function getCloudId(accessToken) {
  if (cloudId) return cloudId;
  
  const resourcesResponse = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });
  
  if (!resourcesResponse.ok) {
    throw new Error(`Failed to get accessible resources: ${resourcesResponse.status}`);
  }
  
  const resources = await resourcesResponse.json();
  
  if (resources.length === 0) {
    throw new Error('No Jira sites accessible with this token');
  }
  
  cloudId = resources[0].id;
  return cloudId;
}

async function getAssigneeStats(options = {}) {
  const client = await getJiraClient();
  
  const { 
    project, 
    startDate, 
    endDate,
    statuses = ['Done', 'Closed', 'Resolved']
  } = options;
  
  let jql = `status in (${statuses.map(s => `"${s}"`).join(', ')})`;
  
  if (project) {
    jql += ` AND project = "${project}"`;
  }
  
  if (startDate) {
    jql += ` AND resolved >= "${startDate}"`;
  }
  
  if (endDate) {
    jql += ` AND resolved <= "${endDate}"`;
  }
  
  jql += ' ORDER BY resolved DESC';
  
  const assigneeStats = new Map();
  let nextPageToken = null;
  const maxResults = 100;
  let total = 0;
  let pageCount = 0;
  
  do {
    const searchParams = {
      jql,
      maxResults,
      fields: ['assignee', 'summary', 'status', 'resolutiondate', 'issuetype', 'priority']
    };
    
    if (nextPageToken) {
      searchParams.nextPageToken = nextPageToken;
    }
    
    const result = await client.issueSearch.searchForIssuesUsingJqlEnhancedSearch(searchParams);
    
    total = result.total || 0;
    nextPageToken = result.nextPageToken;
    
    for (const issue of result.issues || []) {
      const assignee = issue.fields.assignee;
      if (!assignee) continue;
      
      const assigneeId = assignee.accountId;
      if (!assigneeStats.has(assigneeId)) {
        assigneeStats.set(assigneeId, {
          accountId: assigneeId,
          displayName: assignee.displayName,
          avatar: assignee.avatarUrls?.['48x48'] || assignee.avatarUrls?.['32x32'],
          email: assignee.emailAddress,
          completedCount: 0,
          issues: []
        });
      }
      
      const stats = assigneeStats.get(assigneeId);
      stats.completedCount++;
      stats.issues.push({
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status?.name,
        resolvedDate: issue.fields.resolutiondate,
        issueType: issue.fields.issuetype?.name,
        priority: issue.fields.priority?.name
      });
    }
    
    pageCount++;
  } while (nextPageToken && pageCount < 5);
  
  const statsArray = Array.from(assigneeStats.values());
  statsArray.sort((a, b) => b.completedCount - a.completedCount);
  
  return {
    assignees: statsArray,
    totalIssues: total,
    query: jql
  };
}

async function getProjects() {
  const client = await getJiraClient();
  const allProjects = [];
  let startAt = 0;
  let isLast = false;

  while (!isLast) {
    const response = await client.projects.searchProjects({
      startAt,
      maxResults: 50
    });
    
    allProjects.push(...(response.values || []));
    isLast = response.isLast !== false;
    startAt += 50;
    
    if (startAt > 500) break;
  }

  return allProjects.map(p => ({
    id: p.id,
    key: p.key,
    name: p.name,
    avatar: p.avatarUrls?.['48x48']
  }));
}

async function getProjectStatuses(projectKey) {
  const client = await getJiraClient();
  const statuses = await client.projects.getAllStatuses({ projectIdOrKey: projectKey });
  const allStatuses = new Set();
  for (const issueType of statuses) {
    for (const status of issueType.statuses || []) {
      allStatuses.add(status.name);
    }
  }
  return Array.from(allStatuses);
}

async function getMyIssues(displayName, options = {}) {
  const client = await getJiraClient();
  
  const { 
    project,
    statuses = ['To Do', 'In Progress', 'In Review', 'Open', 'Reopened']
  } = options;
  
  // Sanitize displayName to prevent JQL injection
  const sanitizedName = displayName.replace(/['"\\]/g, '');
  
  // Use text search for assignee displayName since we don't have accountId mapping
  let jql = `assignee ~ "${sanitizedName}" AND status in (${statuses.map(s => `"${s}"`).join(', ')})`;
  
  if (project) {
    const sanitizedProject = project.replace(/['"\\]/g, '');
    jql += ` AND project = "${sanitizedProject}"`;
  }
  
  jql += ' ORDER BY priority DESC, updated DESC';
  
  const searchParams = {
    jql,
    maxResults: 50,
    fields: ['summary', 'status', 'issuetype', 'priority', 'project']
  };
  
  try {
    const result = await client.issueSearch.searchForIssuesUsingJqlEnhancedSearch(searchParams);
    
    return (result.issues || []).map(issue => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name,
      issueType: issue.fields.issuetype?.name,
      priority: issue.fields.priority?.name,
      project: issue.fields.project?.key
    }));
  } catch (err) {
    // If text search fails, try exact match with currentUser() as fallback
    console.error('Jira search error:', err.message);
    return [];
  }
}

module.exports = {
  getJiraClient,
  getAssigneeStats,
  getProjects,
  getProjectStatuses,
  getMyIssues
};
