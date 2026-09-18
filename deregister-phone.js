const https = require('https');
const querystring = require('querystring');

const TOKEN = 'EAANfaaknPFMBSiLVRPYVX3AXeP72bScUFlembPCHS0tjKtMjaeniNeyTZCGsd5CsBn60pHEOf89LX1OzZANaglXWro8EuiMlZB58IyewlZCWz0wqIOC6j0zOFujvsEZCzxjtEDJmEjVLQjRSzhT8bwM3TjTIfpDvtSQgff36JUtXAvkuOnCZAmolhLV0RTLSXH76n0u7IqqYh8zLwkn8DhhHKJfwhd8U8eldgtL6P4Cad3RcwBvC1ji3W2LG3STtZBrbKU0bZBB0OMXKaZA4zAy8YptZC8GeZCMIBK6';
const WABA_ID = '1610337593877618';
const API_VERSION = 'v25.0';

console.log('🔍 PASO 1: Obteniendo Phone Number ID actual...\n');

// GET phone numbers
const getOptions = {
  hostname: 'graph.facebook.com',
  path: `/${API_VERSION}/${WABA_ID}/phone_numbers?fields=id,display_phone_number,status,verified_name,quality_rating&access_token=${TOKEN}`,
  method: 'GET',
  headers: {
    'User-Agent': 'Mozilla/5.0'
  }
};

https.request(getOptions, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('📊 RESPUESTA DE META:\n');
    const parsed = JSON.parse(data);
    console.log(JSON.stringify(parsed, null, 2));
    
    if (parsed.data && parsed.data.length > 0) {
      const phoneNumberId = parsed.data[0].id;
      console.log(`\n✅ Phone Number ID encontrado: ${phoneNumberId}`);
      console.log(`📱 Número: ${parsed.data[0].display_phone_number}`);
      console.log(`📊 Estado: ${parsed.data[0].status}`);
      
      // Guardar en archivo para respaldo
      const fs = require('fs');
      const backup = {
        timestamp: new Date().toISOString(),
        action: 'PRE-DEREGISTRATION_BACKUP',
        wabaId: WABA_ID,
        phoneNumbers: parsed.data,
        nextStep: 'READY_FOR_DEREGISTER'
      };
      
      fs.writeFileSync('./backup-before-deregister.json', JSON.stringify(backup, null, 2));
      console.log('\n✅ Respaldo guardado en: ./backup-before-deregister.json');
      
      process.exit(0);
    } else {
      console.error('❌ No se encontraron números de teléfono');
      process.exit(1);
    }
  });
}).on('error', err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
