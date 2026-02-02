const { Version3Client } = require('jira.js');

let connectionSettings = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  // Always fetch fresh token - don't cache
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  console.log('Jira auth - hostname:', hostname, 'hasToken:', !!xReplitToken);

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
    const errText = await response.text();
    console.error('Connector response error:', response.status, errText);
    throw new Error(`Failed to get Jira credentials: ${response.status}`);
  }
  
  const data = await response.json();
  console.log('Connector response keys:', Object.keys(data));
  connectionSettings = data.items?.[0];

  const accessToken = connectionSettings?.settings?.access_token || 
                      connectionSettings?.settings?.oauth?.credentials?.access_token;
  const hostName = connectionSettings?.settings?.site_url;

  console.log('Jira settings - hasAccessToken:', !!accessToken, 'hostName:', hostName);

  if (!connectionSettings || !accessToken || !hostName) {
    console.error('Jira connection settings:', JSON.stringify(connectionSettings, null, 2));
    throw new Error('Jira not connected - please set up Jira integration');
  }

  return { accessToken, hostName };
}

async function getJiraClient() {
  const { accessToken, hostName } = await getAccessToken();

  // Try to get cloud ID for API access
  let apiHost = hostName;
  try {
    const id = await getCloudId(accessToken);
    apiHost = `https://api.atlassian.com/ex/jira/${id}`;
    console.log('Using Atlassian API host with cloudId:', id);
  } catch (err) {
    console.log('CloudId fetch failed, using direct host:', hostName);
  }

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
    statuses = ['Done', 'Closed', 'Resolved', '완료'],
    includeInProgress = true
  } = options;
  
  const completedStatuses = ['Done', 'Closed', 'Resolved', '완료'];
  const inProgressStatuses = ['In Progress', '진행 중', '해야 할 일', '검토 중', 'To Do', 'In Review'];
  
  async function fetchIssues(statusList, isCompleted) {
    let jql = `status in (${statusList.map(s => `"${s}"`).join(', ')})`;
    
    if (project) {
      jql += ` AND project = "${project}"`;
    }
    
    if (isCompleted) {
      if (startDate) jql += ` AND resolved >= "${startDate}"`;
      if (endDate) jql += ` AND resolved <= "${endDate}"`;
      jql += ' ORDER BY resolved DESC';
    } else {
      jql += ' ORDER BY updated DESC';
    }
    
    const assigneeStats = new Map();
    let nextPageToken = null;
    const maxResults = 100;
    let total = 0;
    let pageCount = 0;
    
    do {
      const searchParams = {
        jql,
        maxResults,
        fields: ['assignee', 'summary', 'status', 'resolutiondate', 'issuetype', 'priority', 'updated']
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
            count: 0,
            issues: []
          });
        }
        
        const stats = assigneeStats.get(assigneeId);
        stats.count++;
        stats.issues.push({
          key: issue.key,
          summary: issue.fields.summary,
          status: issue.fields.status?.name,
          resolvedDate: issue.fields.resolutiondate,
          updatedDate: issue.fields.updated,
          issueType: issue.fields.issuetype?.name,
          priority: issue.fields.priority?.name
        });
      }
      
      pageCount++;
    } while (nextPageToken && pageCount < 3);
    
    return { stats: assigneeStats, total };
  }
  
  const completedResult = await fetchIssues(completedStatuses, true);
  
  let inProgressResult = { stats: new Map(), total: 0 };
  if (includeInProgress) {
    inProgressResult = await fetchIssues(inProgressStatuses, false);
  }
  
  const completedArray = Array.from(completedResult.stats.values());
  completedArray.sort((a, b) => b.count - a.count);
  completedArray.forEach(a => { a.completedCount = a.count; delete a.count; });
  
  const inProgressArray = Array.from(inProgressResult.stats.values());
  inProgressArray.sort((a, b) => b.count - a.count);
  inProgressArray.forEach(a => { a.inProgressCount = a.count; delete a.count; });
  
  return {
    assignees: completedArray,
    inProgressAssignees: inProgressArray,
    totalCompleted: completedResult.total,
    totalInProgress: inProgressResult.total,
    totalIssues: completedResult.total + inProgressResult.total
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

async function findUserAccountId(displayName) {
  const { accessToken } = await getAccessToken();
  const id = await getCloudId(accessToken);
  
  const searchUrl = `https://api.atlassian.com/ex/jira/${id}/rest/api/3/user/search?query=${encodeURIComponent(displayName)}`;
  
  const response = await fetch(searchUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });
  
  if (!response.ok) {
    console.error('User search failed:', response.status);
    return null;
  }
  
  const users = await response.json();
  console.log('Jira user search for', displayName, '- found:', users.length);
  
  if (users.length === 0) return null;
  
  const exactMatch = users.find(u => u.displayName === displayName);
  return exactMatch?.accountId || users[0].accountId;
}

async function getMyIssues(displayName, options = {}) {
  const client = await getJiraClient();
  
  const { 
    project = 'Q2'
  } = options;
  
  const accountId = await findUserAccountId(displayName);
  
  if (!accountId) {
    console.log('No Jira user found for:', displayName);
    return [];
  }
  
  const sanitizedProject = project.replace(/['"\\]/g, '');
  
  const doneStatuses = ['Done', 'Closed', 'Resolved', '완료', '종료'];
  const inProgressStatuses = ['To Do', 'In Progress', 'In Review', 'Open', 'Reopened', '진행 중', '해야 할 일', '검토 중', '열림'];
  
  let jql = `assignee = "${accountId}" AND project = "${sanitizedProject}" ORDER BY status DESC, updated DESC`;
  
  const searchParams = {
    jql,
    maxResults: 50,
    fields: ['summary', 'status', 'issuetype', 'priority', 'project', 'resolutiondate']
  };
  
  try {
    console.log('Jira JQL:', jql);
    const result = await client.issueSearch.searchForIssuesUsingJqlEnhancedSearch(searchParams);
    console.log('Jira result count:', result.issues?.length || 0);
    
    return (result.issues || []).map(issue => {
      const originalStatus = issue.fields.status?.name || '';
      const isDone = doneStatuses.some(s => originalStatus.toLowerCase().includes(s.toLowerCase()));
      
      return {
        key: issue.key,
        summary: issue.fields.summary,
        status: originalStatus,
        category: isDone ? 'done' : 'inProgress',
        issueType: issue.fields.issuetype?.name,
        priority: issue.fields.priority?.name,
        project: issue.fields.project?.key
      };
    });
  } catch (err) {
    console.error('Jira search error:', err.message, err.response?.data || '');
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
