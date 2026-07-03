const http = require('@jetbrains/youtrack-scripting-api/http');

exports.httpHandler = {
  endpoints: [
    {
      scope: 'project',
      method: 'POST',
      path: 'holidays',
      handle: function (ctx) {
        const body= ctx.request.json();
        const country = body.country;
        const county = body.county;

        const year = new Date().getFullYear();

        const connection = new http.Connection('https://date.nager.at');
        connection.addHeader('Accept', 'application/json');

        const response = connection.getSync(
            `/api/v3/PublicHolidays/${year}/${country}`
        );

        if (!response || response.code !== 200) {
          ctx.response.json(
              {
                error: 'Failed to fetch holidays',
                response: response?.response,
                code: response?.code
              }
          );
          return;
        }

        let parsedResponse;

        try {
          parsedResponse = JSON.parse(response.response);
        } catch {
          ctx.response.json({
            error: 'Invalid JSON from API'
          });
          return;
        }

        const responseByCountryAndCounty = parsedResponse.filter(holiday => {
          if (!county) return true;
          if (holiday.global === true) return true;
          return Array.isArray(holiday.counties) && holiday.counties.includes(county);
        });

        const filteredHolidays = responseByCountryAndCounty.map(holiday => ({
          date: holiday.date,
          name: holiday.name
        }));

        ctx.project.extensionProperties.holidaysByRegion = JSON.stringify({
          country: country,
          county: county,
          holidays: filteredHolidays
        });


        ctx.response.json({
          country: country,
          county: county || null,
          holidays: filteredHolidays
        });
      }
    },
    {
      scope: 'project',
      method: 'DELETE',
      path: 'holidays',
      handle: function (ctx) {

        ctx.project.extensionProperties.holidaysByRegion = null;

        ctx.response.code = 200;
        ctx.response.json({
          message: 'Holiday dates cleared'
        });
      }
    },
    {
      scope: 'project',
      method: 'GET',
      path: 'holidays',
      handle: function (ctx) {
        const saved = ctx.project.extensionProperties.holidaysByRegion || '{}';
        const data = JSON.parse(saved);
        ctx.response.code = 200;

        ctx.response.json({
          country: data.country || '',
          county: data.county || '',
          holidays: data.holidays || []
        });
      }
    }
  ]
};