// Cloudflare Worker for CodePush API Caching
// This worker intelligently caches CodePush API responses based on update status

// Define your CodePush API paths
const BASE_PATH = '/v0.1/public/codepush';
const UPDATE_CHECK_PATH = `${BASE_PATH}/update_check`;
const API_PATHS = [
  `${BASE_PATH}/report_status/deploy`,
  `${BASE_PATH}/report_status/download`
];

// Cache configuration
const CACHE_NAME = 'codepush-api-cache';
const CACHE_TTL = 86400; // Cache TTL in seconds (24 hours)
const UPDATE_STATUS_KEY = 'update-status'; // KV key prefix to store update status

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event));
});

async function handleRequest(event) {
  const request = event.request;
  const url = new URL(request.url);
  const path = url.pathname;

  // Always fetch the update check from the origin server
  if (path.startsWith(UPDATE_CHECK_PATH)) {
    console.log('Processing update check request');
    return handleUpdateCheck(request);
  }

  // Check if this is one of our API endpoints that should be conditionally cached
  if (API_PATHS.some(apiPath => path.startsWith(apiPath))) {
    console.log(`Processing API request for: ${path}`);
    return handleApiRequest(event, request);
  }

  // For all other requests, pass through to origin
  return fetch(request);
}

async function handleUpdateCheck(request) {
  try {
    // Fetch update check from origin
    const response = await fetch(request.clone());
    const responseClone = response.clone();
    
    // Try to parse the response as JSON
    try {
      const updateData = await response.json();
      
      // For CodePush, an update is available if the response contains 
      // a "download_url" field and is not empty
      const hasUpdate = !!updateData.download_url;
      
      // Store the update status in KV along with request URL to track different apps
      const url = new URL(request.url);
      const deploymentKey = url.searchParams.get('deployment_key') || 'default';
      const appVersion = url.searchParams.get('app_version') || 'unknown';
      
      const statusKey = `${UPDATE_STATUS_KEY}:${deploymentKey}:${appVersion}`;
      
      await CODEPUSH_KV.put(statusKey, JSON.stringify({
        hasUpdate,
        timestamp: Date.now(),
        updateData: hasUpdate ? updateData : null
      }), { expirationTtl: CACHE_TTL });
      
      console.log(`Update check result for ${deploymentKey}@${appVersion}: ${hasUpdate ? 'Update needed' : 'No update needed'}`);
    } catch (error) {
      console.error('Failed to parse update check response:', error);
    }
    
    // Return the original response
    return responseClone;
  } catch (error) {
    console.error('Error handling update check:', error);
    return new Response('Error checking for updates', { status: 500 });
  }
}

async function handleApiRequest(event, request) {
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Extract deployment key and app version to identify the specific app
    let deploymentKey = 'default';
    let appVersion = 'unknown';
    
    // For GET requests, get from query params
    if (request.method === 'GET') {
      deploymentKey = url.searchParams.get('deployment_key') || 'default';
      appVersion = url.searchParams.get('app_version') || 'unknown';
    } 
    // For POST requests, try to get from body
    else if (request.method === 'POST') {
      try {
        const clonedRequest = request.clone();
        const body = await clonedRequest.json();
        deploymentKey = body.deployment_key || 'default';
        appVersion = body.app_version || 'unknown';
      } catch (e) {
        console.error('Failed to parse request body:', e);
      }
    }
    
    const statusKey = `${UPDATE_STATUS_KEY}:${deploymentKey}:${appVersion}`;
    
    // Get the current update status from KV for this specific app/deployment
    const updateStatusJson = await CODEPUSH_KV.get(statusKey);
    
    // If no update status exists yet, fetch from origin
    if (!updateStatusJson) {
      console.log(`No update status found for ${deploymentKey}@${appVersion}, fetching from origin`);
      return fetch(request);
    }
    
    const updateStatus = JSON.parse(updateStatusJson);
    
    // If an update is needed, bypass cache and fetch from origin
    if (updateStatus.hasUpdate) {
      console.log(`Update needed for ${deploymentKey}@${appVersion}, fetching from origin`);
      return fetch(request);
    }
    
    // No update needed, try to fetch from cache first
    console.log(`No update needed for ${deploymentKey}@${appVersion}, checking cache`);
    
    // Create a cache key that includes relevant parameters
    const cacheKey = new Request(request.url, {
      method: request.method,
      headers: request.headers,
    });
    
    // Check if we have a cached response
    const cache = caches.default;
    let response = await cache.match(cacheKey);
    
    if (response) {
      console.log('Cache hit, returning cached response');
      return response;
    }
    
    // If not in cache, fetch from origin and cache the response
    console.log('Cache miss, fetching from origin');
    response = await fetch(request);
    
    // Only cache successful responses
    if (response.status === 200) {
      // Clone the response so we can return one and cache one
      const responseToCache = response.clone();
      
      // Cache the response with the TTL
      event.waitUntil(cache.put(cacheKey, responseToCache));
    }
    
    return response;
  } catch (error) {
    console.error('Error handling API request:', error);
    return fetch(request);
  }
}
