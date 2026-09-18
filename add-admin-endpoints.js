// ============================================
// ADMIN ENDPOINTS - DEREGISTER PHONE NUMBER (TEMPORAL)
// ============================================

/**
 * GET /admin/deregister-status
 */
app.get('/admin/deregister-status', async (req, res) => {
  const adminKey = req.query.key || req.headers['x-admin-key'];
  if (adminKey !== 'tomcat-admin-2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    logEvent('ADMIN_DEREGISTER_STATUS_REQUESTED', { timestamp: new Date().toISOString(), targetWaba: targetWabaId });

    const phoneNumbersResponse = await axios.get(
      `https://graph.facebook.com/v25.0/${targetWabaId}/phone_numbers`,
      { params: { fields: 'id,display_phone_number,status,verified_name,quality_rating', access_token: metaAccessToken } }
    );

    const phoneNumbers = phoneNumbersResponse.data.data || [];
    const backup = {
      timestamp: new Date().toISOString(),
      action: 'PRE-DEREGISTRATION_STATUS',
      wabaId: targetWabaId,
      phoneNumbers: phoneNumbers,
      targetPhoneNumber: targetPhoneNumber,
      status: 'READY_FOR_DEREGISTER'
    };

    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    fs.writeFileSync(path.join(backupDir, `backup-${Date.now()}.json`), JSON.stringify(backup, null, 2));

    res.json({
      success: true,
      message: 'Números obtenidos ✅',
      wabaId: targetWabaId,
      phoneNumbers: phoneNumbers,
      nextStep: 'POST /admin/deregister-number'
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message, details: error.response?.data });
  }
});

/**
 * POST /admin/deregister-number
 */
app.post('/admin/deregister-number', async (req, res) => {
  const { phone_number_id, key } = req.body;
  if (key !== 'tomcat-admin-2026') return res.status(401).json({ error: 'Unauthorized' });
  if (!phone_number_id) return res.status(400).json({ error: 'phone_number_id required' });

  try {
    logEvent('ADMIN_DEREGISTER_STARTED', { phone_number_id, targetPhoneNumber, timestamp: new Date().toISOString() });

    const deregisterResponse = await axios.post(`https://graph.facebook.com/v25.0/${phone_number_id}/deregister`, {}, { params: { access_token: metaAccessToken } });

    const deregisterRecord = { timestamp: new Date().toISOString(), action: 'PHONE_NUMBER_DEREGISTERED', phone_number_id, targetPhoneNumber, wabaId: targetWabaId, response: deregisterResponse.data, status: 'SUCCESS' };

    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    fs.writeFileSync(path.join(backupDir, `deregister-${Date.now()}.json`), JSON.stringify(deregisterRecord, null, 2));

    const postDeregisterStatus = await axios.get(`https://graph.facebook.com/v25.0/${targetWabaId}/phone_numbers`, { params: { fields: 'id,display_phone_number,status', access_token: metaAccessToken } });

    res.json({
      success: true,
      message: '✅ Número desregistrado',
      phone_number_id,
      postDeregisterStatus: postDeregisterStatus.data.data || [],
      nextSteps: [
        '1. Desvinculación completada de Cloud API',
        '2. Registra el número en WhatsApp Business App',
        '3. Intenta Coexistence con Embedded Signup v4'
      ]
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message, details: error.response?.data });
  }
});

app.get('/admin/verify-deregister', async (req, res) => {
  const adminKey = req.query.key || req.headers['x-admin-key'];
  if (adminKey !== 'tomcat-admin-2026') return res.status(401).json({ error: 'Unauthorized' });

  try {
    const currentStatus = await axios.get(`https://graph.facebook.com/v25.0/${targetWabaId}/phone_numbers`, { params: { fields: 'id,display_phone_number,status', access_token: metaAccessToken } });
    const targetNumber = currentStatus.data.data?.find(p => p.display_phone_number === targetPhoneNumber);

    res.json({
      success: true,
      wabaId: targetWabaId,
      currentPhoneNumbers: currentStatus.data.data,
      verification: targetNumber ? 'Aún en WABA' : '✅ Desvinculado',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message, details: error.response?.data });
  }
});
