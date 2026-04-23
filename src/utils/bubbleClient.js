/**
 * Data client — Supabase implementation.
 * Returns clean Supabase column names (no Bubble _text/_boolean suffixes).
 */

import { supabase } from './supabaseClient.js';

// ── Business / Listings ──────────────────────────────────────────────────────

export async function insertListing(listing) {
  const row = {
    listing_id:       listing.listing_id       ?? null,
    business_name:    listing.business_name     ?? null,
    description:      listing.description       ?? null,
    location:         listing.location          ?? null,
    region:           listing.region            ?? null,
    sector:           listing.sector            ?? null,
    url:              listing.url               ?? null,
    image:            listing.image             ?? null,
    asking_price:     listing.asking_price      ?? null,
    turnover:         listing.turnover          ?? null,
    net_profit:       listing.net_profit        ?? null,
    rent:             listing.rent              ?? null,
    leasehold:        listing.leasehold         ?? null,
    source:           listing.source            ?? null,
    sub_sector:       listing.sub_sector        ?? null,
    ebit:             listing.ebit              ?? null,
    ebitda:           listing.ebitda            ?? null,
    freehold:         listing.freehold          ?? null,
    franchise_fee:    listing.franchise_fee     ?? null,
    investment:       listing.investment        ?? null,
    more_info:        listing.more_info         ?? null,
    other_financials: listing.other_financials  ?? null,
    last_seen_at:     new Date().toISOString(),
    archived:         false,
  };

  console.log(`[db] insertListing listing_id=${listing.listing_id}`);

  const { data, error } = await supabase
    .from('business')
    .insert(row)
    .select('id')
    .single();

  if (error) throw new Error(`insertListing failed: ${error.message}`);
  return { id: data.id };
}

export async function checkListingExists(listing_id) {
  console.log(`[db] checkListingExists listing_id=${listing_id}`);

  const { count, error } = await supabase
    .from('business')
    .select('*', { count: 'exact', head: true })
    .eq('listing_id', listing_id);

  if (error) throw new Error(`checkListingExists failed: ${error.message}`);
  return (count ?? 0) > 0;
}

export async function getStaleListings(cursor = 0) {
  const staleThreshold = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();

  const { data: results, count, error } = await supabase
    .from('business')
    .select('*', { count: 'exact' })
    .eq('archived', false)
    .lt('last_seen_at', staleThreshold)
    .range(cursor, cursor + 99);

  if (error) throw new Error(`getStaleListings failed: ${error.message}`);

  const total = count ?? 0;
  const remaining = Math.max(0, total - cursor - (results?.length ?? 0));

  return { results: results ?? [], remaining, count: results?.length ?? 0 };
}

export async function archiveListing(id) {
  const { error } = await supabase
    .from('business')
    .update({ archived: true })
    .eq('id', id);
  if (error) throw new Error(`archiveListing failed: ${error.message}`);
}

export async function touchListing(id) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('business')
    .update({ last_seen_at: now, last_verified_at: now, archived: false })
    .eq('id', id);
  if (error) throw new Error(`touchListing failed: ${error.message}`);
}

export async function getBubbleIdByListingId(listing_id) {
  const { data, error } = await supabase
    .from('business')
    .select('id')
    .eq('listing_id', listing_id)
    .limit(1)
    .single();

  console.log(`[db] getBubbleIdByListingId listing_id=${listing_id} found=${!!data}`);
  if (error || !data) return null;
  return data.id;
}

export async function getBusinessByName(name) {
  const { data, error } = await supabase
    .from('business')
    .select('*')
    .ilike('business_name', `%${name}%`)
    .eq('archived', false)
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}

export async function getBusinessById(id) {
  const { data, error } = await supabase
    .from('business')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) throw new Error(`getBusinessById failed: ${error?.message ?? 'not found'}`);
  return data;
}

// ── Matches ──────────────────────────────────────────────────────────────────

export async function getExistingMatches(userId) {
  const ids = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('matches')
      .select('business_id')
      .eq('user_id', userId)
      .range(offset, offset + 99);

    if (error) throw new Error(`getExistingMatches failed: ${error.message}`);
    data.forEach(m => { if (m.business_id) ids.push(m.business_id); });
    if (data.length < 100) break;
    offset += 100;
  }

  return ids;
}

export async function getDismissedMatchesWithReasons(userId) {
  const results = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('matches')
      .select('business_id, dismiss_reason')
      .eq('user_id', userId)
      .eq('dismissed', true)
      .range(offset, offset + 99);

    if (error) throw new Error(`getDismissedMatchesWithReasons failed: ${error.message}`);
    for (const m of data) {
      if (m.dismiss_reason && m.business_id) {
        results.push({ businessId: m.business_id, reason: m.dismiss_reason });
      }
    }
    if (data.length < 100) break;
    offset += 100;
  }

  return results;
}

export async function getTodaysMatchesForUser(userId) {
  const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .eq('user_id', userId)
    .gt('created_at', since)
    .limit(100);

  if (error) throw new Error(`getTodaysMatchesForUser failed: ${error.message}`);
  return data ?? [];
}

export async function getTopMatchesForUser(userId, limit = 5) {
  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .eq('user_id', userId)
    .neq('dismissed', true)
    .order('score', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`getTopMatchesForUser failed: ${error.message}`);
  return data ?? [];
}

// ── Users ────────────────────────────────────────────────────────────────────

export async function getActiveSubscribers() {
  const ids = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('users')
      .select('id')
      .eq('is_subscribed', true)
      .range(offset, offset + 99);

    if (error) throw new Error(`getActiveSubscribers failed: ${error.message}`);
    data.forEach(u => { if (u.id) ids.push(u.id); });
    if (data.length < 100) break;
    offset += 100;
  }

  return ids;
}

export async function getUserDetails(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) throw new Error(`getUserDetails failed: ${error.message}`);
  return data;
}

export async function getAdminUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('email')
    .eq('is_admin', true);

  if (error) throw new Error(`getAdminUsers failed: ${error.message}`);
  return (data ?? []).map(u => u.email).filter(Boolean);
}

export async function setUserLangcliffeConnected(userId) {
  const { error } = await supabase
    .from('users')
    .update({ langcliffe_connected: true })
    .eq('id', userId);
  if (error) throw new Error(`setUserLangcliffeConnected failed: ${error.message}`);
}

// ── Agents ───────────────────────────────────────────────────────────────────

export async function getAgentForUser(userId) {
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .eq('user_id', userId)
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}

export async function getAgentByEmail(agentEmail) {
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .eq('email', agentEmail)
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}

// ── Buyer Info ───────────────────────────────────────────────────────────────

export async function getBuyerInfo(userId) {
  const { data, error } = await supabase
    .from('buyer_info')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) throw new Error(`getBuyerInfo failed: ${error.message}`);
  return { results: data ?? [], count: data?.length ?? 0, remaining: 0 };
}

export async function updateBuyerCriteria(userId, updates) {
  const { error } = await supabase
    .from('buyer_info')
    .update(updates)
    .eq('user_id', userId);

  if (error) throw new Error(`updateBuyerCriteria failed: ${error.message}`);
}

// ── Emails ───────────────────────────────────────────────────────────────────

export async function createEmailRecord({ body, threadId, userId }) {
  const { error } = await supabase
    .from('emails')
    .insert({
      body,
      is_agent: true,
      thread_id: threadId,
      user_id: userId,
    });
  if (error) throw new Error(`createEmailRecord failed: ${error.message}`);
}

export async function getEmailRecordByThreadId(threadId) {
  const { data, error } = await supabase
    .from('emails')
    .select('id, user_id')
    .eq('thread_id', threadId)
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}

export async function getEmailThreadForUser(userId) {
  const { data, error } = await supabase
    .from('emails')
    .select('body, is_agent')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(100);

  if (error) throw new Error(`getEmailThreadForUser failed: ${error.message}`);
  return data ?? [];
}

export async function saveInboundEmailRecord({ body, threadId, userId }) {
  const { error } = await supabase
    .from('emails')
    .insert({
      body,
      is_agent: false,
      thread_id: threadId,
      user_id: userId,
    });
  if (error) throw new Error(`saveInboundEmailRecord failed: ${error.message}`);
}

// ── Scrape Log ───────────────────────────────────────────────────────────────

export async function createScrapeLog({ added, archived, matches }) {
  const { error } = await supabase
    .from('scrape_log')
    .insert({
      last_run: new Date().toISOString(),
      records_added: added,
      records_archived: archived,
      matches_made: matches,
    });
  if (error) throw new Error(`createScrapeLog failed: ${error.message}`);
}

export async function getLatestScrapeLog() {
  const { data, error } = await supabase
    .from('scrape_log')
    .select('*')
    .order('last_run', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}

// ── Langcliffe Outreach ──────────────────────────────────────────────────────

export async function checkOutreachExists(userId, listingId) {
  const { count, error } = await supabase
    .from('langcliffe_outreach')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('listing_id', listingId);

  if (error) throw new Error(`checkOutreachExists failed: ${error.message}`);
  return (count ?? 0) > 0;
}

export async function createOutreachDraft({ userId, listingId, langcliffeContact, businessName, draftBody, inboundEmail = '' }) {
  const { data, error } = await supabase
    .from('langcliffe_outreach')
    .insert({
      user_id: userId,
      listing_id: listingId,
      langcliffe_contact: langcliffeContact,
      business_name: businessName,
      draft_body: draftBody,
      inbound_email: inboundEmail,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) throw new Error(`createOutreachDraft failed: ${error.message}`);
  return data.id;
}

export async function getLangcliffeOutreach(outreachId) {
  const { data, error } = await supabase
    .from('langcliffe_outreach')
    .select('*')
    .eq('id', outreachId)
    .single();

  if (error) throw new Error(`getLangcliffeOutreach failed: ${error.message}`);
  return data;
}

export async function getPendingOutreachQueue() {
  const statuses = ['pending', 'pending_reply', 'nda_received', 'nda_signed', 'misc'];

  const { data, error } = await supabase
    .from('langcliffe_outreach')
    .select('*')
    .in('status', statuses)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`getPendingOutreachQueue failed: ${error.message}`);

  // Enrich with user emails
  const userIds = [...new Set((data ?? []).map(r => r.user_id).filter(Boolean))];
  const userEmails = {};
  if (userIds.length > 0) {
    const { data: users } = await supabase
      .from('users')
      .select('id, email')
      .in('id', userIds);
    (users ?? []).forEach(u => { userEmails[u.id] = u.email; });
  }

  return (data ?? []).map(o => ({
    ...o,
    user_email: userEmails[o.user_id] ?? null,
  }));
}

export async function approveOutreach(outreachId, threadMessageId = null) {
  const update = { status: 'sent', sent_at: new Date().toISOString() };
  if (threadMessageId) update.thread_message_id = threadMessageId;

  const { error } = await supabase
    .from('langcliffe_outreach')
    .update(update)
    .eq('id', outreachId);
  if (error) throw new Error(`approveOutreach failed: ${error.message}`);
}

export async function rejectOutreach(outreachId, newDraftBody) {
  const { error } = await supabase
    .from('langcliffe_outreach')
    .update({ draft_body: newDraftBody, status: 'pending' })
    .eq('id', outreachId);
  if (error) throw new Error(`rejectOutreach failed: ${error.message}`);
}

const ACTIVE_STATUSES = ['sent', 'pending_reply', 'nda_received', 'nda_acknowledged', 'nda_signed', 'nda_returned'];

export async function getMostRecentSentOutreach(userId) {
  const { data, error } = await supabase
    .from('langcliffe_outreach')
    .select('*')
    .eq('user_id', userId)
    .in('status', ACTIVE_STATUSES)
    .order('sent_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}

export async function getOutreachByContact(userId, langcliffeContactEmail) {
  const { data, error } = await supabase
    .from('langcliffe_outreach')
    .select('*')
    .eq('user_id', userId)
    .eq('langcliffe_contact', langcliffeContactEmail)
    .in('status', ACTIVE_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}

export async function updateOutreachReply({ outreachId, langcliffeReplyBody, replyDraft, conversationHistory }) {
  const { error } = await supabase
    .from('langcliffe_outreach')
    .update({
      langcliffe_reply_body: langcliffeReplyBody,
      reply_draft: replyDraft,
      conversation_history: conversationHistory,
      status: 'pending_reply',
    })
    .eq('id', outreachId);
  if (error) throw new Error(`updateOutreachReply failed: ${error.message}`);
}

export async function approveReply(outreachId, conversationHistory) {
  const update = { status: 'sent', sent_at: new Date().toISOString() };
  if (conversationHistory) update.conversation_history = conversationHistory;

  const { error } = await supabase
    .from('langcliffe_outreach')
    .update(update)
    .eq('id', outreachId);
  if (error) throw new Error(`approveReply failed: ${error.message}`);
}

export async function updateReplyDraft(outreachId, replyDraft) {
  const { error } = await supabase
    .from('langcliffe_outreach')
    .update({ reply_draft: replyDraft, status: 'pending_reply' })
    .eq('id', outreachId);
  if (error) throw new Error(`updateReplyDraft failed: ${error.message}`);
}

export async function deleteOutreach(outreachId) {
  const { error } = await supabase
    .from('langcliffe_outreach')
    .delete()
    .eq('id', outreachId);
  if (error) throw new Error(`deleteOutreach failed: ${error.message}`);
}

export async function updateOutreachNDA({ outreachId, ndaFileUrl, replyBody, ackDraft }) {
  const { error } = await supabase
    .from('langcliffe_outreach')
    .update({
      nda_file: ndaFileUrl,
      langcliffe_reply_body: replyBody,
      acknowledgment_draft: ackDraft,
      status: 'nda_received',
    })
    .eq('id', outreachId);
  if (error) throw new Error(`updateOutreachNDA failed: ${error.message}`);
}

export async function approveAcknowledgment(outreachId) {
  const { error } = await supabase
    .from('langcliffe_outreach')
    .update({ status: 'nda_acknowledged' })
    .eq('id', outreachId);
  if (error) throw new Error(`approveAcknowledgment failed: ${error.message}`);
}

export async function storeIMDetails(outreachId, { imUrl, imPassword }) {
  const update = { status: 'im_received', im_url: imUrl };
  if (imPassword) update.im_password = imPassword;

  const { error } = await supabase
    .from('langcliffe_outreach')
    .update(update)
    .eq('id', outreachId);
  if (error) throw new Error(`storeIMDetails failed: ${error.message}`);
}

export async function storeSignedNDA(outreachId, signedNdaFileUrl) {
  console.log(`[db] storeSignedNDA outreachId=${outreachId} fileUrl=${signedNdaFileUrl}`);

  const { error } = await supabase
    .from('langcliffe_outreach')
    .update({ signed_nda_file: signedNdaFileUrl, status: 'nda_signed' })
    .eq('id', outreachId);
  if (error) throw new Error(`storeSignedNDA failed: ${error.message}`);
}

export async function updateNDAReturnDraft(outreachId, ndaReturnDraft) {
  const { error } = await supabase
    .from('langcliffe_outreach')
    .update({ nda_return_draft: ndaReturnDraft, status: 'nda_signed' })
    .eq('id', outreachId);
  if (error) throw new Error(`updateNDAReturnDraft failed: ${error.message}`);
}

export async function approveNDAReturn(outreachId) {
  const { error } = await supabase
    .from('langcliffe_outreach')
    .update({ status: 'nda_returned' })
    .eq('id', outreachId);
  if (error) throw new Error(`approveNDAReturn failed: ${error.message}`);
}

export async function createMiscInboundRecord(userId, fromEmail, emailBody) {
  const { error } = await supabase
    .from('langcliffe_outreach')
    .insert({
      user_id: userId,
      status: 'misc',
      langcliffe_contact: fromEmail,
      langcliffe_reply_body: emailBody,
      listing_id: `misc_${Date.now()}`,
      business_name: `Unknown — ${fromEmail}`,
    });
  if (error) throw new Error(`createMiscInboundRecord failed: ${error.message}`);
}

// ── Notifications ────────────────────────────────────────────────────────────

export async function createUserNotification({ userId, type, title, body, outreachId }) {
  const { error } = await supabase
    .from('user_notification')
    .insert({
      user_id: userId,
      type,
      title,
      body,
      langcliffe_outreach: outreachId,
      status: 'unread',
    });
  if (error) throw new Error(`createUserNotification failed: ${error.message}`);
}

export async function getExistingUserNotification(userId, outreachId) {
  const { data, error } = await supabase
    .from('user_notification')
    .select('*')
    .eq('user_id', userId)
    .eq('langcliffe_outreach', outreachId)
    .eq('status', 'unread')
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}

export async function updateUserNotification(notificationId, { title, body }) {
  const { error } = await supabase
    .from('user_notification')
    .update({ title, body })
    .eq('id', notificationId);
  if (error) throw new Error(`updateUserNotification failed: ${error.message}`);
}

export async function getUserNotifications(userId) {
  const { data, error } = await supabase
    .from('user_notification')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'unread')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`getUserNotifications failed: ${error.message}`);
  return data ?? [];
}

export async function markNotificationActioned(notificationId) {
  const { error } = await supabase
    .from('user_notification')
    .update({ status: 'actioned' })
    .eq('id', notificationId);
  if (error) throw new Error(`markNotificationActioned failed: ${error.message}`);
}

// ── Pursue Requests ──────────────────────────────────────────────────────────

export async function createPursueRequest({ userId, businessId, businessName, listingUrl }) {
  const { data, error } = await supabase
    .from('pursue_request')
    .insert({
      user_id: userId,
      business_id: businessId,
      business_name: businessName,
      status: 'pending',
      listing_url: listingUrl ?? '',
      notified_status: 'pending',
    })
    .select('id')
    .single();

  if (error) throw new Error(`createPursueRequest failed: ${error.message}`);
  return data.id;
}

export async function getPursueRequests() {
  const { data, error } = await supabase
    .from('pursue_request')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw new Error(`getPursueRequests failed: ${error.message}`);
  return data ?? [];
}

export async function getUserPursueRequests(userId) {
  const { data, error } = await supabase
    .from('pursue_request')
    .select('*')
    .eq('user_id', userId)
    .neq('status', 'closed')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw new Error(`getUserPursueRequests failed: ${error.message}`);
  return data ?? [];
}

export async function updatePursueRequest(requestId, updates) {
  const { error } = await supabase
    .from('pursue_request')
    .update(updates)
    .eq('id', requestId);
  if (error) throw new Error(`updatePursueRequest failed: ${error.message}`);
}

// ── Feature Announcements ────────────────────────────────────────────────────

export async function getActiveFeatureAnnouncements() {
  const { data, error } = await supabase
    .from('feature_announcement')
    .select('*')
    .eq('active', true);

  if (error) throw new Error(`getActiveFeatureAnnouncements failed: ${error.message}`);
  return data ?? [];
}

export async function getAllFeatureAnnouncements() {
  const { data, error } = await supabase
    .from('feature_announcement')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`getAllFeatureAnnouncements failed: ${error.message}`);
  return data ?? [];
}

export async function createFeatureAnnouncement(data) {
  const { data: result, error } = await supabase
    .from('feature_announcement')
    .insert({
      name: data.name,
      headline: data.headline,
      cta: data.cta,
      active: data.active ?? true,
      max_impressions: data.max_impressions,
      completion_field: data.completion_field,
    })
    .select('id')
    .single();

  if (error) throw new Error(`createFeatureAnnouncement failed: ${error.message}`);
  return result.id;
}

export async function updateFeatureAnnouncement(id, data) {
  const { error } = await supabase
    .from('feature_announcement')
    .update(data)
    .eq('id', id);
  if (error) throw new Error(`updateFeatureAnnouncement failed: ${error.message}`);
}

export async function getUserFeatureImpressions(userId) {
  const { data, error } = await supabase
    .from('user_feature_impression')
    .select('*')
    .eq('user_id', userId);

  if (error) throw new Error(`getUserFeatureImpressions failed: ${error.message}`);
  return data ?? [];
}

export async function incrementFeatureImpression(userId, featureId) {
  const { data: existing } = await supabase
    .from('user_feature_impression')
    .select('id, impressions')
    .eq('user_id', userId)
    .eq('feature_id', featureId)
    .limit(1)
    .single();

  if (existing) {
    const { error } = await supabase
      .from('user_feature_impression')
      .update({ impressions: (existing.impressions ?? 0) + 1 })
      .eq('id', existing.id);
    if (error) throw new Error(`incrementFeatureImpression update failed: ${error.message}`);
  } else {
    const { error } = await supabase
      .from('user_feature_impression')
      .insert({ user_id: userId, feature_id: featureId, impressions: 1 });
    if (error) throw new Error(`incrementFeatureImpression insert failed: ${error.message}`);
  }
}

export async function getFeatureImpressionStats(featureId) {
  const { data, error } = await supabase
    .from('user_feature_impression')
    .select('impressions')
    .eq('feature_id', featureId);

  if (error) throw new Error(`getFeatureImpressionStats failed: ${error.message}`);

  const results = data ?? [];
  const totalImpressions = results.reduce((sum, r) => sum + (r.impressions ?? 0), 0);
  return { totalImpressions, uniqueUsers: results.length, impressions: results };
}

// ── File Upload ──────────────────────────────────────────────────────────────

export async function uploadFile(buffer, filename, mimeType) {
  const path = `nda/${Date.now()}_${filename}`;

  const { error } = await supabase.storage
    .from('files')
    .upload(path, buffer, { contentType: mimeType });

  if (error) throw new Error(`File upload failed: ${error.message}`);

  // Return the storage path — callers store this in the DB.
  // Signed URLs are generated on access via getSignedFileUrl().
  return path;
}

/** Generate a short-lived signed URL for a private file. */
export async function getSignedFileUrl(path, expiresInSeconds = 3600) {
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from('files')
    .createSignedUrl(path, expiresInSeconds);
  if (error) return null;
  return data.signedUrl;
}

// Keep old name as alias so existing callers don't break
export const uploadFileToBubble = uploadFile;
