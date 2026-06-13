export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { area, rooms, price } = req.body;

  // Map area to yad2 params
  // topArea=19 = Sharon, area=70 = Emek Hefer, city codes for Makmura area
  const areaParams = {
    'מכמורת': 'topArea=19&area=70&city=8400', // Makmura city code
    'עמק חפר מערבי': 'topArea=19&area=70',
    'מכמורת ועמק חפר': 'topArea=19&area=70',
  };

  const minRooms = (!rooms || rooms === '0') ? '' : rooms;
  const maxPrice = price || '';

  const areaQuery = areaParams[area] || 'topArea=19&area=70';
  const roomsQuery = minRooms ? `&rooms=${minRooms}-` : '';
  const priceQuery = maxPrice ? `&price=-1-${maxPrice}` : '';

  const yad2Url = `https://gw.yad2.co.il/feed-search-legacy/realestate/rent?${areaQuery}${roomsQuery}${priceQuery}&forceLdLoad=true`;

  try {
    // Try yad2 API first
    const yad2Res = await fetch(yad2Url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Referer': 'https://www.yad2.co.il/',
        'Origin': 'https://www.yad2.co.il',
      }
    });

    if (yad2Res.ok) {
      const yad2Data = await yad2Res.json();
      const items = yad2Data?.data?.feed?.feed_items || [];

      const listings = items
        .filter(item => item.type === 'ad' && item.id)
        .slice(0, 20)
        .map(item => ({
          title: item.title || `${item.rooms} חדרים ב${item.city}`,
          location: [item.street, item.house_number, item.neighborhood, item.city].filter(Boolean).join(' '),
          rooms: item.rooms,
          size: item.square_meters,
          price: item.price,
          floor: item.floor_text || (item.floor != null ? String(item.floor) : null),
          description: item.additional_info_items?.map(i => i.text).join(' | ') || '',
          source: 'יד2',
          url: `https://www.yad2.co.il/item/${item.id}`,
          date: item.date,
        }));

      return res.status(200).json({
        listings,
        summary: `נמצאו ${listings.length} נכסים עדכניים ביד2`,
        source: 'yad2_api',
      });
    }

    // Fallback: Claude AI search
    throw new Error(`yad2 returned ${yad2Res.status}`);

  } catch (yad2Error) {
    // Fallback to Claude with web search
    try {
      const roomsText = minRooms ? `, לפחות ${minRooms} חדרים` : '';
      const priceText = maxPrice ? `, עד ${parseInt(maxPrice).toLocaleString('he-IL')} ש"ח לחודש` : '';

      const prompt = `חפש נכסים להשכרה ב${area}${roomsText}${priceText} באתרי נדל"ן ישראליים (יד2, מדלן, הומלס).
החזר JSON בלבד:
{"listings":[{"title":"...","location":"...","rooms":4,"size":120,"price":7500,"floor":"קרקע","description":"...","source":"יד2","url":"https://..."}],"summary":"..."}`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 4000,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          system: 'אתה סוכן נדל"ן. ענה ב-JSON בלבד ללא טקסט נוסף.',
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const claudeData = await claudeRes.json();
      let messages = [{ role: 'user', content: prompt }];
      let finalData = claudeData;
      let iters = 0;

      while (finalData.stop_reason === 'tool_use' && iters < 5) {
        iters++;
        messages.push({ role: 'assistant', content: finalData.content });
        const toolResults = finalData.content
          .filter(b => b.type === 'tool_use')
          .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(b.content || '') }));
        messages.push({ role: 'user', content: toolResults });

        const nextRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'web-search-2025-03-05',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 4000,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            system: 'אתה סוכן נדל"ן. ענה ב-JSON בלבד ללא טקסט נוסף.',
            messages,
          }),
        });
        finalData = await nextRes.json();
      }

      const rawText = finalData.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const clean = rawText.replace(/```json|```/g, '').trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) return res.status(200).json({ listings: [], summary: rawText.slice(0, 400), source: 'claude_fallback' });

      const parsed = JSON.parse(match[0]);
      return res.status(200).json({ ...parsed, source: 'claude_fallback', yad2_error: yad2Error.message });

    } catch (claudeError) {
      return res.status(500).json({ error: claudeError.message, yad2_error: yad2Error.message });
    }
  }
}
