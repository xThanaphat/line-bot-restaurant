require('dotenv').config();
// Required modules
const line = require('@line/bot-sdk');
const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');
const querystring = require('querystring');

// LINE Bot Configuration
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

// Google Sheets Configuration
const auth = new google.auth.GoogleAuth({
  keyFile: './service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// LINE Notify Token
const LINE_NOTIFY_TOKEN = process.env.LINE_NOTIFY_TOKEN;

// Create LINE SDK client
const client = new line.Client(config);

// Create Express app
const app = express();

// User cart storage (in production, use Redis or database)
const userCarts = {};

// Webhook handler
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// Event handler
async function handleEvent(event) {
  const userId = event.source.userId;
  
  // Initialize user cart if not exists
  if (!userCarts[userId]) {
    userCarts[userId] = {
      items: {},
      total: 0
    };
  }

  if (event.type === 'message' && event.message.type === 'text') {
    return handleTextMessage(event);
  } else if (event.type === 'postback') {
    return handlePostback(event);
  } else if (event.type === 'follow') {
    return handleFollow(event);
  }

  return Promise.resolve(null);
}

// Handle text messages
async function handleTextMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.toLowerCase();

  console.log('User sent text:', text);
  
  if (text === 'สั่งอาหาร' || text === 'order') {
    // Show category selection
    return client.replyMessage(event.replyToken, getCategoryFlex());
  } else if (text === 'โปรโมชั่น' || text === 'โปร') {
    // Show promotions
    return client.replyMessage(event.replyToken, getPromotionFlex());
  } else if (text === 'เมนูแนะนำ') {
    // Show recommended menu
    return client.replyMessage(event.replyToken, getRecommendedMenuFlex());
  } else if (text === 'ติดต่อ' || text === 'help') {
    // Send notification to staff
    await sendLineNotify('มีลูกค้าต้องการติดต่อ! UserID: ' + userId);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'เราได้แจ้งพนักงานแล้ว จะติดต่อกลับโดยเร็วที่สุดค่ะ 😊'
    });
  } else if (text === 'ดูตะกร้า' || text === 'cart') {
    // Show cart
    return client.replyMessage(event.replyToken, getCartFlex(userId));
  } else if (text === 'เช็คบิล' || text === 'บิล') {
    // Generate bill
    return client.replyMessage(event.replyToken, getBillFlex(userId));
  } else if (text.includes('อาหารจานเดียว') || text.includes('กับข้าว') || 
             text.includes('สลัด') || text.includes('ต้ม') || 
             text.includes('เครื่องดื่ม') || text.includes('ของหวาน')) {
    // Show menu by category
    const category = text;
    const menuItems = await getMenuByCategory(category);
    return client.replyMessage(event.replyToken, createMenuFlex(menuItems));
  }

  // Default response
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: 'กรุณาเลือกเมนูจาก Rich Menu ด้านล่างค่ะ 😊'
  });
}

// Handle postback events
async function handlePostback(event) {
  const userId = event.source.userId;
  const data = querystring.parse(event.postback.data);

  if (data.action === 'add' || data.action === 'increase') {
    // Add item to cart
    const item = data.item;
    if (!userCarts[userId].items[item]) {
      userCarts[userId].items[item] = { count: 0, price: getItemPrice(item) };
    }
    userCarts[userId].items[item].count++;
    
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `เพิ่ม ${getItemName(item)} แล้วค่ะ ✅`
    });
  } else if (data.action === 'remove' || data.action === 'decrease') {
    // Remove item from cart
    const item = data.item;
    if (userCarts[userId].items[item] && userCarts[userId].items[item].count > 0) {
      userCarts[userId].items[item].count--;
      if (userCarts[userId].items[item].count === 0) {
        delete userCarts[userId].items[item];
      }
    }
    
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `ลด ${getItemName(item)} แล้วค่ะ ✅`
    });
  } else if (data.action === 'confirm_order') {
    // Confirm order
    const orderDetails = prepareOrderDetails(userId);
    const orderId = generateOrderId();
    
    // Send to kitchen
    await sendLineNotify(`📋 ออเดอร์ใหม่!\nOrder ID: ${orderId}\n${orderDetails}`);
    
    // Save to Google Sheets
    await saveOrderToSheets(userId, userCarts[userId], orderId);
    
    // Store order ID for bill generation
    userCarts[userId].lastOrderId = orderId;
    
    // Clear cart items but keep order ID
    userCarts[userId].items = {};
    userCarts[userId].total = 0;
    
    return client.replyMessage(event.replyToken, [
      {
        type: 'text',
        text: 'ยืนยันคำสั่งซื้อเรียบร้อยแล้วค่ะ ✅\nกำลังส่งไปยังห้องครัว...'
      },
      getBillFlex(userId, orderId)
    ]);
  }

  return Promise.resolve(null);
}

// Handle follow event
async function handleFollow(event) {
  const welcomeMessage = getWelcomeFlex();
  return client.replyMessage(event.replyToken, welcomeMessage);
}

// Get menu items from Google Sheets
async function getMenuByCategory(category) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Menu!A2:G100' // Adjust range as needed
    });

    const rows = response.data.values;
    return rows.filter(row => row[2] === category && row[5] === 'TRUE').map(row => ({
      id: row[0],
      name: row[1],
      category: row[2],
      price: parseInt(row[3]),
      image: row[4],
      description: row[6] || ''
    }));
  } catch (err) {
    console.error('Error reading from Sheets:', err);
    return [];
  }
}

// Save order to Google Sheets
async function saveOrderToSheets(userId, cart, orderId) {
  const timestamp = new Date().toISOString();
  const total = calculateTotal(cart);
  const itemsList = Object.entries(cart.items)
    .map(([item, data]) => `${getItemName(item)} x${data.count}`)
    .join(', ');

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Orders!A:G',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          timestamp,
          userId,
          itemsList,
          total,
          'pending',
          'unpaid',
          orderId
        ]]
      }
    });
  } catch (err) {
    console.error('Error writing to Sheets:', err);
  }
}

// Send LINE Notify
async function sendLineNotify(message) {
  try {
    await axios.post('https://notify-api.line.me/api/notify', 
      `message=${encodeURIComponent(message)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Bearer ${LINE_NOTIFY_TOKEN}`
        }
      }
    );
  } catch (err) {
    console.error('Error sending LINE Notify:', err);
  }
}

// Helper functions
function calculateTotal(cart) {
  return Object.values(cart.items).reduce((sum, item) => sum + (item.price * item.count), 0);
}

function getItemPrice(itemId) {
  const prices = {
    'padthai': 60,
    'tomyum': 120,
    'greencurry': 80,
    'somtam': 50,
    'friedrice': 60,
    'papayasalad': 45,
    'icedtea': 25,
    'mangorice': 60
  };
  return prices[itemId] || 0;
}

function getItemName(itemId) {
  const names = {
    'padthai': 'ผัดไทย',
    'tomyum': 'ต้มยำกุ้ง',
    'greencurry': 'แกงเขียวหวาน',
    'somtam': 'ส้มตำ',
    'friedrice': 'ข้าวผัด',
    'papayasalad': 'ยำมะระวงใส',
    'icedtea': 'ชาเย็น',
    'mangorice': 'ข้าวเหนียวมะม่วง'
  };
  return names[itemId] || itemId;
}

function generateOrderId() {
  const date = new Date();
  const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `ORDER${dateStr}${random}`;
}

function prepareOrderDetails(userId) {
  const cart = userCarts[userId];
  const items = Object.entries(cart.items)
    .map(([item, data]) => `- ${getItemName(item)} x${data.count} = ฿${data.price * data.count}`)
    .join('\n');
  const total = calculateTotal(cart);
  
  return `รายการ:\n${items}\n\nรวม: ฿${total}`;
}

// Flex Message Functions
function getWelcomeFlex() {
  return {
    type: 'flex',
    altText: 'ยินดีต้อนรับสู่ร้านอาหารของเรา!',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'image',
                url: 'https://via.placeholder.com/800x400/FFE5E5/FF6B6B?text=Welcome',
                size: 'full',
                aspectMode: 'cover',
                aspectRatio: '2:1'
              }
            ]
          }
        ],
        paddingAll: '0px'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🍜 ยินดีต้อนรับ',
                size: 'xl',
                weight: 'bold',
                color: '#FF6B6B'
              },
              {
                type: 'text',
                text: 'ร้านอาหารน่ารัก',
                size: 'xxl',
                weight: 'bold',
                margin: 'sm'
              }
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: 'พร้อมเสิร์ฟความอร่อยทุกวัน',
                size: 'md',
                color: '#666666',
                wrap: true
              },
              {
                type: 'text',
                text: 'เปิดทุกวัน 10.00 - 20.00 น.',
                size: 'sm',
                color: '#999999',
                margin: 'sm'
              }
            ],
            margin: 'lg'
          },
          {
            type: 'separator',
            margin: 'xl'
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: '✨ เริ่มต้นสั่งอาหารได้เลย!',
                size: 'md',
                color: '#FF6B6B',
                weight: 'bold',
                align: 'center',
                flex: 1
              }
            ],
            margin: 'xl'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            action: {
              type: 'message',
              label: '🍱 สั่งอาหาร',
              text: 'สั่งอาหาร'
            },
            style: 'primary',
            color: '#FF6B6B',
            height: 'md'
          },
          {
            type: 'button',
            action: {
              type: 'message',
              label: '🎉 ดูโปรโมชั่น',
              text: 'โปรโมชั่น'
            },
            style: 'secondary',
            height: 'sm',
            margin: 'sm'
          }
        ]
      },
      styles: {
        header: {
          backgroundColor: '#FFFFFF'
        },
        body: {
          backgroundColor: '#FFFFFF'
        },
        footer: {
          backgroundColor: '#F5F5F5'
        }
      }
    }
  };
}

function getCategoryFlex() {
  return {
    type: 'flex',
    altText: 'เลือกหมวดหมู่อาหาร',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '🍽️ เลือกหมวดหมู่',
            size: 'xl',
            weight: 'bold',
            color: '#333333',
            align: 'center'
          }
        ],
        backgroundColor: '#F5F5F5',
        paddingAll: '20px'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'button',
                    action: {
                      type: 'message',
                      label: '🍜',
                      text: 'อาหารจานเดียว'
                    },
                    style: 'secondary',
                    height: '80px'
                  },
                  {
                    type: 'text',
                    text: 'อาหารจานเดียว',
                    size: 'sm',
                    color: '#666666',
                    align: 'center',
                    margin: 'sm'
                  }
                ],
                flex: 1,
                spacing: 'none',
                margin: 'sm'
              },
              {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'button',
                    action: {
                      type: 'message',
                      label: '🥘',
                      text: 'กับข้าว'
                    },
                    style: 'secondary',
                    height: '80px'
                  },
                  {
                    type: 'text',
                    text: 'กับข้าว',
                    size: 'sm',
                    color: '#666666',
                    align: 'center',
                    margin: 'sm'
                  }
                ],
                flex: 1,
                spacing: 'none',
                margin: 'sm'
              }
            ],
            spacing: 'md'
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'button',
                    action: {
                      type: 'message',
                      label: '🥗',
                      text: 'สลัด/ยำ'
                    },
                    style: 'secondary',
                    height: '80px'
                  },
                  {
                    type: 'text',
                    text: 'สลัด/ยำ',
                    size: 'sm',
                    color: '#666666',
                    align: 'center',
                    margin: 'sm'
                  }
                ],
                flex: 1,
                spacing: 'none',
                margin: 'sm'
              },
              {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'button',
                    action: {
                      type: 'message',
                      label: '🍲',
                      text: 'ต้ม/แกง'
                    },
                    style: 'secondary',
                    height: '80px'
                  },
                  {
                    type: 'text',
                    text: 'ต้ม/แกง',
                    size: 'sm',
                    color: '#666666',
                    align: 'center',
                    margin: 'sm'
                  }
                ],
                flex: 1,
                spacing: 'none',
                margin: 'sm'
              }
            ],
            spacing: 'md',
            margin: 'lg'
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'button',
                    action: {
                      type: 'message',
                      label: '🥤',
                      text: 'เครื่องดื่ม'
                    },
                    style: 'secondary',
                    height: '80px'
                  },
                  {
                    type: 'text',
                    text: 'เครื่องดื่ม',
                    size: 'sm',
                    color: '#666666',
                    align: 'center',
                    margin: 'sm'
                  }
                ],
                flex: 1,
                spacing: 'none',
                margin: 'sm'
              },
              {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'button',
                    action: {
                      type: 'message',
                      label: '🍰',
                      text: 'ของหวาน'
                    },
                    style: 'secondary',
                    height: '80px'
                  },
                  {
                    type: 'text',
                    text: 'ของหวาน',
                    size: 'sm',
                    color: '#666666',
                    align: 'center',
                    margin: 'sm'
                  }
                ],
                flex: 1,
                spacing: 'none',
                margin: 'sm'
              }
            ],
            spacing: 'md',
            margin: 'lg'
          }
        ],
        paddingAll: '10px'
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            action: {
              type: 'message',
              label: '🛒 ดูตะกร้า',
              text: 'ดูตะกร้า'
            },
            style: 'primary',
            color: '#FF6B6B'
          }
        ]
      }
    }
  };
}

function getPromotionFlex() {
  return {
    type: 'flex',
    altText: 'โปรโมชั่นพิเศษ',
    contents: {
      type: 'carousel',
      contents: [
        {
          type: 'bubble',
          size: 'kilo',
          hero: {
            type: 'image',
            url: 'https://via.placeholder.com/400x200/FFE5E5/FF6B6B?text=Buy+1+Get+1',
            size: 'full',
            aspectMode: 'cover',
            aspectRatio: '2:1'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🎉 ซื้อ 1 แถม 1',
                size: 'xl',
                weight: 'bold',
                color: '#FF6B6B'
              },
              {
                type: 'text',
                text: 'ผัดไทย ซื้อ 1 แถม 1',
                size: 'md',
                margin: 'sm',
                wrap: true
              },
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  {
                    type: 'text',
                    text: 'ปกติ ฿120',
                    size: 'sm',
                    color: '#999999',
                    decoration: 'line-through'
                  },
                  {
                    type: 'text',
                    text: '฿60',
                    size: 'xl',
                    color: '#FF6B6B',
                    weight: 'bold',
                    margin: 'md'
                  }
                ],
                margin: 'md'
              },
              {
                type: 'text',
                text: '⏰ วันนี้เท่านั้น!',
                size: 'sm',
                color: '#666666',
                margin: 'md'
              }
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: 'สั่งเลย!',
                  text: 'สั่งอาหาร'
                },
                style: 'primary',
                color: '#FF6B6B'
              }
            ]
          }
        },
        {
          type: 'bubble',
          size: 'kilo',
          hero: {
            type: 'image',
            url: 'https://via.placeholder.com/400x200/E5F3FF/4ECDC4?text=20%25+OFF',
            size: 'full',
            aspectMode: 'cover',
            aspectRatio: '2:1'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '💙 ลด 20%',
                size: 'xl',
                weight: 'bold',
                color: '#4ECDC4'
              },
              {
                type: 'text',
                text: 'เมนูต้มยำ ทุกชนิด',
                size: 'md',
                margin: 'sm',
                wrap: true
              },
              {
                type: 'text',
                text: 'เมื่อสั่ง 2 ที่ขึ้นไป',
                size: 'sm',
                color: '#666666',
                margin: 'sm'
              },
              {
                type: 'text',
                text: '📅 1-7 กรกฎาคม 2568',
                size: 'sm',
                color: '#666666',
                margin: 'md'
              }
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: 'สั่งเลย!',
                  text: 'สั่งอาหาร'
                },
                style: 'primary',
                color: '#4ECDC4'
              }
            ]
          }
        }
      ]
    }
  };
}

function getRecommendedMenuFlex() {
  return {
    type: 'flex',
    altText: 'เมนูแนะนำ',
    contents: {
      type: 'carousel',
      contents: [
        {
          type: 'bubble',
          size: 'micro',
          hero: {
            type: 'image',
            url: 'https://via.placeholder.com/300x200/FFE5CC/FF6B6B?text=Best+Seller',
            size: 'full',
            aspectMode: 'cover',
            aspectRatio: '3:2'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '⭐ ผัดไทยกุ้งสด',
                weight: 'bold',
                size: 'md',
                wrap: true
              },
              {
                type: 'text',
                text: 'Best Seller!',
                size: 'xs',
                color: '#FF6B6B',
                margin: 'xs'
              },
              {
                type: 'box',
                layout: 'baseline',
                contents: [
                  {
                    type: 'text',
                    text: '฿60',
                    size: 'lg',
                    color: '#FF6B6B',
                    weight: 'bold',
                    flex: 0
                  }
                ],
                margin: 'sm'
              }
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                action: {
                  type: 'postback',
                  label: 'สั่งเลย',
                  data: 'action=add&item=padthai'
                },
                style: 'primary',
                color: '#FF6B6B',
                height: 'sm'
              }
            ]
          }
        },
        {
          type: 'bubble',
          size: 'micro',
          hero: {
            type: 'image',
            url: 'https://via.placeholder.com/300x200/E5F3FF/4ECDC4?text=Chef+Pick',
            size: 'full',
            aspectMode: 'cover',
            aspectRatio: '3:2'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '👨‍🍳 ต้มยำกุ้งน้ำข้น',
                weight: 'bold',
                size: 'md',
                wrap: true
              },
              {
                type: 'text',
                text: "Chef's Pick!",
                size: 'xs',
                color: '#4ECDC4',
                margin: 'xs'
              },
              {
                type: 'box',
                layout: 'baseline',
                contents: [
                  {
                    type: 'text',
                    text: '฿120',
                    size: 'lg',
                    color: '#4ECDC4',
                    weight: 'bold',
                    flex: 0
                  }
                ],
                margin: 'sm'
              }
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                action: {
                  type: 'postback',
                  label: 'สั่งเลย',
                  data: 'action=add&item=tomyum'
                },
                style: 'primary',
                color: '#4ECDC4',
                height: 'sm'
              }
            ]
          }
        }
      ]
    }
  };
}

function getCartFlex(userId) {
  const cart = userCarts[userId];
  const total = calculateTotal(cart);
  
  // If cart is empty
  if (Object.keys(cart.items).length === 0) {
    return {
      type: 'text',
      text: 'ตะกร้าของคุณยังว่างเปล่าค่ะ 🛒\nกรุณาเลือกเมนูก่อนนะคะ'
    };
  }
  
  // Build cart items
  const cartItems = Object.entries(cart.items).map(([itemId, data]) => {
    return {
      type: 'box',
      layout: 'horizontal',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: getItemName(itemId),
              size: 'md',
              weight: 'bold',
              flex: 1
            },
            {
              type: 'text',
              text: `฿${data.price}`,
              size: 'sm',
              color: '#666666'
            }
          ],
          flex: 3
        },
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'button',
              action: {
                type: 'postback',
                label: '-',
                data: `action=decrease&item=${itemId}`
              },
              style: 'secondary',
              height: 'sm'
            },
            {
              type: 'text',
              text: data.count.toString(),
              align: 'center',
              gravity: 'center',
              size: 'md',
              margin: 'sm'
            },
            {
              type: 'button',
              action: {
                type: 'postback',
                label: '+',
                data: `action=increase&item=${itemId}`
              },
              style: 'secondary',
              height: 'sm'
            }
          ],
          flex: 2,
          spacing: 'xs',
          alignItems: 'center'
        },
        {
          type: 'text',
          text: `฿${data.price * data.count}`,
          size: 'md',
          weight: 'bold',
          color: '#FF6B6B',
          align: 'end',
          gravity: 'center',
          flex: 1
        }
      ],
      spacing: 'md',
      paddingAll: '10px'
    };
  });
  
  // Add separator after each item except the last one
  const itemsWithSeparators = [];
  cartItems.forEach((item, index) => {
    itemsWithSeparators.push(item);
    if (index < cartItems.length - 1) {
      itemsWithSeparators.push({
        type: 'separator',
        margin: 'md'
      });
    }
  });
  
  return {
    type: 'flex',
    altText: 'ตะกร้าสินค้า',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '🛒 ตะกร้าของคุณ',
            size: 'xl',
            weight: 'bold',
            color: '#333333'
          }
        ],
        backgroundColor: '#F5F5F5',
        paddingAll: '20px'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          ...itemsWithSeparators,
          {
            type: 'separator',
            margin: 'lg'
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: 'ยอดรวม',
                size: 'lg',
                weight: 'bold',
                flex: 1
              },
              {
                type: 'text',
                text: `฿${total}`,
                size: 'xl',
                weight: 'bold',
                color: '#FF6B6B',
                align: 'end'
              }
            ],
            margin: 'lg'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            action: {
              type: 'postback',
              label: '✅ ยืนยันคำสั่งซื้อ',
              data: 'action=confirm_order'
            },
            style: 'primary',
            color: '#FF6B6B',
            height: 'md'
          },
          {
            type: 'button',
            action: {
              type: 'message',
              label: '🍽️ เพิ่มเมนูอื่น',
              text: 'สั่งอาหาร'
            },
            style: 'secondary',
            height: 'sm',
            margin: 'sm'
          }
        ],
        spacing: 'sm'
      }
    }
  };
}

function getBillFlex(userId, orderId) {
  const cart = userCarts[userId];
  const total = calculateTotal(cart);
  const timestamp = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  
  // If no order ID provided, use the last order ID
  if (!orderId) {
    orderId = cart.lastOrderId || 'N/A';
  }
  
  // Build order items for bill
  const orderItems = Object.entries(cart.items).map(([itemId, data]) => {
    return {
      type: 'box',
      layout: 'horizontal',
      contents: [
        {
          type: 'text',
          text: `${getItemName(itemId)} x${data.count}`,
          size: 'sm',
          flex: 3
        },
        {
          type: 'text',
          text: `฿${data.price * data.count}`,
          size: 'sm',
          align: 'end',
          flex: 1
        }
      ],
      margin: 'sm'
    };
  });
  
  return {
    type: 'flex',
    altText: 'บิลค่าอาหาร',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'image',
            url: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${orderId}`,
            size: '150px',
            align: 'center'
          },
          {
            type: 'text',
            text: 'ร้านอาหารน่ารัก',
            size: 'xl',
            weight: 'bold',
            align: 'center',
            margin: 'md'
          },
          {
            type: 'text',
            text: 'ใบเสร็จรับเงิน',
            size: 'md',
            color: '#666666',
            align: 'center'
          }
        ],
        backgroundColor: '#F5F5F5',
        paddingAll: '20px'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: 'เลขที่บิล:',
                size: 'sm',
                color: '#666666',
                flex: 2
              },
              {
                type: 'text',
                text: orderId,
                size: 'sm',
                align: 'end',
                flex: 3
              }
            ]
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: 'วันที่:',
                size: 'sm',
                color: '#666666',
                flex: 2
              },
              {
                type: 'text',
                text: timestamp,
                size: 'sm',
                align: 'end',
                flex: 3
              }
            ],
            margin: 'sm'
          },
          {
            type: 'separator',
            margin: 'lg'
          },
          {
            type: 'text',
            text: 'รายการอาหาร',
            size: 'md',
            weight: 'bold',
            margin: 'lg'
          },
          ...orderItems,
          {
            type: 'separator',
            margin: 'lg'
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: 'ยอดรวม',
                size: 'lg',
                weight: 'bold',
                flex: 1
              },
              {
                type: 'text',
                text: `฿${total}`,
                size: 'xl',
                weight: 'bold',
                color: '#FF6B6B',
                align: 'end'
              }
            ],
            margin: 'lg'
          },
          {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🙏 ขอบคุณที่ใช้บริการ',
                size: 'sm',
                color: '#666666',
                align: 'center',
                margin: 'xl'
              }
            ]
          }
        ],
        paddingAll: '20px'
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            action: {
              type: 'uri',
              label: '💳 ชำระเงิน',
              uri: `https://payment.example.com/${orderId}`
            },
            style: 'primary',
            color: '#FF6B6B'
          }
        ]
      },
      styles: {
        header: {
          separator: false
        }
      }
    }
  };
}

function createMenuFlex(items) {
  if (!items || items.length === 0) {
    return {
      type: 'text',
      text: 'ขออภัยค่ะ ยังไม่มีเมนูในหมวดนี้'
    };
  }
  
  const bubbles = items.map(item => {
    // Generate simple item ID from name
    const itemId = item.id || item.name.toLowerCase().replace(/\s+/g, '');
    
    return {
      type: 'bubble',
      size: 'micro',
      hero: {
        type: 'image',
        url: item.image || `https://via.placeholder.com/300x200/FFE5CC/FF6B6B?text=${encodeURIComponent(item.name)}`,
        size: 'full',
        aspectMode: 'cover',
        aspectRatio: '3:2'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: item.name,
            weight: 'bold',
            size: 'md',
            wrap: true
          },
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              {
                type: 'text',
                text: `฿${item.price}`,
                size: 'lg',
                color: '#FF6B6B',
                weight: 'bold',
                flex: 0
              }
            ],
            margin: 'sm'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'button',
                action: {
                  type: 'postback',
                  label: '➖',
                  data: `action=remove&item=${itemId}`
                },
                flex: 1,
                height: 'sm'
              },
              {
                type: 'text',
                text: '0',
                align: 'center',
                gravity: 'center',
                flex: 1
              },
              {
                type: 'button',
                action: {
                  type: 'postback',
                  label: '➕',
                  data: `action=add&item=${itemId}`
                },
                flex: 1,
                height: 'sm'
              }
            ],
            spacing: 'xs'
          }
        ],
        spacing: 'xs'
      }
    };
  });
  
  return {
    type: 'flex',
    altText: 'เมนูอาหาร',
    contents: {
      type: 'carousel',
      contents: bubbles
    }
  };
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LINE Bot server is running on port ${PORT}`);
});

// Export for testing
module.exports = {
  app,
  handleEvent,
  getWelcomeFlex,
  getCategoryFlex,
  getPromotionFlex,
  getCartFlex,
  getBillFlex,
  createMenuFlex
};
