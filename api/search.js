export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { area, rooms, price } = req.body;

  const roomsText = (!rooms || rooms === '0') ? '' : `, לפחות ${rooms} חדרים`;
  const priceText = price ? `, עד ${parseInt(price).toLocaleString('he-IL')} ש"ח לחודש` : '';

  const prompt = `חפש נכסים להשכרה ב${area}${roomsText}${priceText}.

החזר JSON בלבד, ללא שום טקסט נוסף, במבנה הבא:
{
  "listings": [
    {
      "title": "כותרת הנכס",
      "location": "כתובת או שכונה",
      "rooms": 4,
      "size": 120,
      "price": 7500,
      "floor": "קרקע",
      "description": "תיאור קצר של הנכס",
      "source": "יד2",
      "url": "https://www.yad2.co.il/..."
    }
  ],
  "summary": "סיכום קצר של התוצאות"
}

אם אין לך מידע עדכני על נכסים ספציפיים, החזר listings ריק עם summary מסביר.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'אתה סוכן נדל"ן ישראלי מומחה. חפש נכסים אמיתיים להשכרה באינטרנט. ענה תמיד ב-JSON בלבד ללא שום טקסט נוסף לפני או אחרי.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `Anthropic API error: ${err.slice(0, 200)}` });
    }

    const data = await response.json();

    // Handle multi-turn if needed (web search requires agentic loop)
    let allMessages = [{ role: 'user', content: prompt }];
    let finalData = data;
    let iterations = 0;

    while (finalData.stop_reason === 'tool_use' && iterations < 5) {
      iterations++;
      allMessages.push({ role: 'assistant', content: finalData.content });

      const toolResults = finalData.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: JSON.stringify(b.content || '')
        }));

      allMessages.push({ role: 'user', content: toolResults });

      const nextResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 4000,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          system: 'אתה סוכן נדל"ן ישראלי מומחה. ענה תמיד ב-JSON בלבד ללא שום טקסט נוסף.',
          messages: allMessages
        })
      });

      finalData = await nextResponse.json();
    }

    // Extract text
    const rawText = finalData.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Parse JSON
    const clean = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'No JSON in response', raw: rawText.slice(0, 300) });

    const parsed = JSON.parse(match[0]);
    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
