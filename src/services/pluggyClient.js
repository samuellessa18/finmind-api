'use strict';

const axios = require('axios');

const BASE_URL = 'https://api.pluggy.ai';

// In-memory token cache — Pluggy API tokens expire in 2h
let cachedToken     = null;
let tokenExpiresAt  = 0;

async function getApiToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const { data } = await axios.post(`${BASE_URL}/auth`, {
    clientId:     process.env.PLUGGY_CLIENT_ID,
    clientSecret: process.env.PLUGGY_CLIENT_SECRET,
  });

  cachedToken    = data.apiKey;
  // Expire 5 min before actual expiry (tokens last 2h)
  tokenExpiresAt = Date.now() + (2 * 60 - 5) * 60 * 1000;
  return cachedToken;
}

async function withRetry(fn, retries = 3, baseDelayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;

      // Force token refresh on 401
      if (status === 401) {
        cachedToken   = null;
        tokenExpiresAt = 0;
      }

      // Don't retry on client errors (except 401 which gets a fresh token)
      if (status && status >= 400 && status < 500 && status !== 401) {
        throw err;
      }

      if (attempt === retries) throw err;

      const delay = baseDelayMs * 2 ** (attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function buildClient(apiKey) {
  return axios.create({
    baseURL: BASE_URL,
    headers: { 'X-API-KEY': apiKey },
    timeout: 30000,
  });
}

/**
 * Creates a Connect Token for the Pluggy widget.
 * clientUserId is our internal userId — used for webhook routing.
 */
async function createConnectToken(clientUserId, options = {}) {
  return withRetry(async () => {
    const apiKey = await getApiToken();
    const client = buildClient(apiKey);
    const { data } = await client.post('/connect_token', {
      clientUserId,
      ...options,
    });
    return data.accessToken;
  });
}

/**
 * Gets a Pluggy Item (bank connection status).
 */
async function getItem(itemId) {
  return withRetry(async () => {
    const apiKey = await getApiToken();
    const client = buildClient(apiKey);
    const { data } = await client.get(`/items/${itemId}`);
    return data;
  });
}

/**
 * Gets all accounts for a Pluggy Item.
 */
async function getAccounts(itemId) {
  return withRetry(async () => {
    const apiKey = await getApiToken();
    const client = buildClient(apiKey);
    const { data } = await client.get(`/accounts?itemId=${itemId}`);
    return data.results ?? [];
  });
}

/**
 * Gets transactions for an account with optional date filters.
 * Pluggy paginates with pageSize max 500.
 */
async function getTransactions(accountId, { from, to, pageSize = 500, page = 1 } = {}) {
  return withRetry(async () => {
    const apiKey  = await getApiToken();
    const client  = buildClient(apiKey);
    const params  = new URLSearchParams({ accountId, pageSize, page });
    if (from) params.set('from', from);
    if (to)   params.set('to', to);

    const { data } = await client.get(`/transactions?${params.toString()}`);
    return {
      results: data.results ?? [],
      total:   data.total   ?? 0,
      page:    data.page    ?? 1,
      totalPages: data.totalPages ?? 1,
    };
  });
}

/**
 * Deletes a Pluggy Item (revokes consent).
 */
async function deleteItem(itemId) {
  return withRetry(async () => {
    const apiKey = await getApiToken();
    const client = buildClient(apiKey);
    await client.delete(`/items/${itemId}`);
  });
}

module.exports = {
  getApiToken,
  createConnectToken,
  getItem,
  getAccounts,
  getTransactions,
  deleteItem,
};
