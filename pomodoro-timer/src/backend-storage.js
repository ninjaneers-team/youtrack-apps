const EXTENSION_PROPERTY_KEY = 'pomodoroUserData';

const getUserId = (ctx) => {
  let userId = null;
  
  if (ctx.currentUser) {
    if (ctx.currentUser.id) {
      userId = ctx.currentUser.id;
    } else if (ctx.currentUser.login) {
      userId = ctx.currentUser.login;
    }
  }
  
  if (!userId && ctx.user) {
    if (ctx.user.id) {
      userId = ctx.user.id;
    } else if (ctx.user.login) {
      userId = ctx.user.login;
    }
  }
  
  return userId || 'anonymous';
};

const getAllUserData = (ctx) => {
  try {
    const rawData = ctx.issue.extensionProperties[EXTENSION_PROPERTY_KEY];
    if (rawData) {
      return JSON.parse(rawData);
    }
  } catch (error) {
    console.error('Error parsing user data:', error);
  }
  return {};
};

const saveAllUserData = (ctx, userData) => {
  try {
    ctx.issue.extensionProperties[EXTENSION_PROPERTY_KEY] = JSON.stringify(userData);
    return true;
  } catch (error) {
    console.error('Error saving user data:', error);
    return false;
  }
};

exports.httpHandler = {
  endpoints: [
    {
      scope: 'issue',
      method: 'GET',
      path: 'timer-data',
      handle: function handleGetTimerData(ctx) {
        try {
          const userId = getUserId(ctx);
          
          const allUserData = getAllUserData(ctx);
          const userData = allUserData[userId];
          
          if (userData && typeof userData === 'object') {
            const responseData = { ...userData, userId: userId };
            ctx.response.json(responseData);
          } else {
            const initialState = {
              currentTime: 60,
              mode: 'focus',
              isRunning: false,
              totalFocusTime: 0,
              todos: [],
              nextTodoId: 1,
              userId: userId
            };
            ctx.response.json(initialState);
          }
        } catch (error) {
          ctx.response.code = 500;
          ctx.response.json({ 
            error: 'Failed to load timer data', 
            message: error.message 
          });
        }
      }
    },
    {
      scope: 'issue',
      method: 'POST',
      path: 'timer-data',
      handle: function handlePostTimerData(ctx) {
        try {
          const userId = getUserId(ctx);
          
          if (ctx.request.parameterNames && ctx.request.parameterNames.length > 0) {
            const action = ctx.request.getParameter('action');
            const dataParam = ctx.request.getParameter('data');
            
            if (action === 'save' && dataParam) {
              try {
                const data = JSON.parse(dataParam);
                
                if (!data || typeof data !== 'object') {
                  ctx.response.code = 400;
                  ctx.response.json({ 
                    error: 'Invalid data format',
                    received: typeof data
                  });
                  return;
                }
                
                const allUserData = getAllUserData(ctx);
                allUserData[userId] = data;
                const saved = saveAllUserData(ctx, allUserData);
                
                if (saved) {
                  ctx.response.json({ 
                    success: true,
                    message: `Timer data saved successfully for user ${userId}`,
                    userId: userId
                  });
                } else {
                  ctx.response.code = 500;
                  ctx.response.json({ 
                    error: 'Failed to save data to extension property'
                  });
                }
                return;
                
              } catch (parseError) {
                console.error('Failed to parse timer data from query param:', parseError);
                ctx.response.code = 400;
                ctx.response.json({ 
                  error: 'Invalid JSON in data parameter',
                  parseError: parseError.message
                });
                return;
              }
            }
          }
          
          if (!ctx.request.body || ctx.request.body.trim() === '') {
            ctx.response.code = 400;
            ctx.response.json({ 
              error: 'No data provided - empty body and no query parameters'
            });
            return;
          }
          
          let data;
          try {
            if (typeof ctx.request.body === 'string') {
              data = JSON.parse(ctx.request.body);
            } else {
              data = ctx.request.json();
            }
          } catch (parseError) {
            console.error('JSON parse error:', parseError);
            ctx.response.code = 400;
            ctx.response.json({ 
              error: 'Invalid JSON in request body',
              parseError: parseError.message
            });
            return;
          }
          
          if (!data || typeof data !== 'object') {
            ctx.response.code = 400;
            ctx.response.json({ 
              error: 'Invalid data format',
              received: typeof data
            });
            return;
          }
          
          const allUserData = getAllUserData(ctx);
          allUserData[userId] = data;
          const saved = saveAllUserData(ctx, allUserData);
          
          if (saved) {
            ctx.response.json({ 
              success: true,
              message: `Timer data saved successfully for user ${userId} via body`,
              userId: userId
            });
          } else {
            ctx.response.code = 500;
            ctx.response.json({ 
              error: 'Failed to save data to extension property'
            });
          }
        } catch (error) {
          console.error('Error in POST handler:', error);
          ctx.response.code = 500;
          ctx.response.json({ 
            error: 'Failed to save timer data', 
            message: error.message,
            stack: error.stack
          });
        }
      }
    },
    {
      scope: 'issue',
      method: 'DELETE',
      path: 'timer-data',
      handle: function handleDeleteTimerData(ctx) {
        try {
          const userId = getUserId(ctx);
          const allUserData = getAllUserData(ctx);
          delete allUserData[userId];
          const saved = saveAllUserData(ctx, allUserData);
          
          if (saved) {
            ctx.response.json({ 
              success: true,
              message: `Timer data cleared successfully for user ${userId}`,
              userId: userId
            });
          } else {
            ctx.response.code = 500;
            ctx.response.json({ 
              error: 'Failed to clear data from extension property'
            });
          }
        } catch (error) {
          console.error('Error in DELETE handler:', error);
          ctx.response.code = 500;
          ctx.response.json({ 
            error: 'Failed to clear timer data', 
            message: error.message 
          });
        }
      }
    }
  ]
};
