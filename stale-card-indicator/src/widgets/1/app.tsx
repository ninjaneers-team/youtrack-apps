import React, { memo, useCallback, useEffect, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Panel from '@jetbrains/ring-ui-built/components/panel/panel';
import Group from '@jetbrains/ring-ui-built/components/group/group';
import Text from '@jetbrains/ring-ui-built/components/text/text';
import Input from '@jetbrains/ring-ui-built/components/input/input';

const host = await YTApp.register();

const HolidaysWidget: React.FunctionComponent = () => {
  const [inputCountry, setInputCountry] = useState('');
  const [inputCounty, setInputCounty] = useState('');
  const [savedCountry, setSavedCountry] = useState('');
  const [savedCounty, setSavedCounty] = useState('');
  const [holidays, setHolidays] = useState<{ date: string; name: string }[]>([]);
  const [message, setMessage] = useState<string | null>(null);

    const fetchSavedHolidays = useCallback(async() => {
      try {
        const response = await host.fetchApp<{
          country:string,
          county: string,
          holidays: { date: string; name: string }[]
        }>('backend/holidays', {
          scope: true,
          method: 'GET'
        });
        if (response) {
          setHolidays(response.holidays || []);
          setSavedCountry(response.country || '');
          setSavedCounty(response.county || '');
        }

        setHolidays(response.holidays || []);
      } catch {
        setMessage('Failed to fetch saved holidays');
      }
    }, [host]);

  const fetchHolidays = useCallback(async() => {
    if (!inputCountry) {
      setMessage('Please enter a country code');
      return;
    }

    setMessage(null);

    try {
          const response = await host.fetchApp<{
            holidays: { date: string; name: string }[]
          }>(
          'backend/holidays',
          { scope: true,
            method: 'POST',
            body: {country: inputCountry, county: inputCounty}
          }
    );

      setHolidays(response.holidays ?? []);
      setMessage(`Fetched ${response.holidays?.length ?? 0} holidays.`);
    } catch {
      setHolidays([]);
      setMessage('Error fetching holidays.');
    }
  }, [inputCountry, inputCounty]);

  const clearHolidays = useCallback(async () => {
    setMessage(null);
    try {
      await host.fetchApp('backend/holidays', { scope: true, method: 'DELETE' });
      setHolidays([]);
      setMessage('Holiday dates cleared.');
    } catch {
      setMessage('Error clearing holidays.');
    }
  }, []);

  useEffect(() => {
    fetchSavedHolidays();
  }, [fetchSavedHolidays]);

  return (
    <div
      className="widget"
      style={{
            width: '700px',
            maxWidth: '100%',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
    >
      {/* Header */}
      <Panel style={{ padding: '16px' }}>
        <h2 style={{ margin: 0 }}>📅 Holiday Configuration</h2>
        <Text style={{ color: '#6B7280' }}>
          Manage public holidays used for stale level calculations.
        </Text>
      </Panel>

      {/* Holiday Source */}
      <Panel style={{ padding: '16px' }}>
        <h3 style={{ marginTop: 0 }}>Holiday Source</h3>

        <div
          style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
        >
          <Input
            value={inputCountry}
            onChange={(e) => setInputCountry(e.target.value)}
            placeholder="Country code (e.g. DE)"
          />

          <Input
            value={inputCounty}
            onChange={(e) => setInputCounty(e.target.value)}
            placeholder="County (optional, e.g. DE-HE)"
          />

          <Group>
            <Button primary onClick={fetchHolidays}>
              Fetch Holidays
            </Button>

            <Button onClick={clearHolidays}>
              Clear Holidays
            </Button>
          </Group>
        </div>
      </Panel>

      {/* Status Message */}
      {message && (
        <Panel
          style={{
                  padding: '10px 16px',
                  backgroundColor: message.toLowerCase().includes('error')
                      ? '#FEECEC'
                      : '#EDF7ED',
                  borderLeft: message.toLowerCase().includes('error')
                      ? '4px solid #D93025'
                      : '4px solid #2E7D32',
                }}
        >
          <Text>{message}</Text>
        </Panel>
        )}

      {/* Configured Holidays */}
      <Panel style={{ padding: '16px' }}>
        <h3 style={{ marginTop: 0 }}>Configured Holidays</h3>

        {holidays.length === 0 && (
          <Text style={{ color: '#6B7280' }}>
            No holidays configured.
          </Text>
          )}

        {holidays.length > 0 && (
          <>
            {/* Summary */}
            <div
              style={{
                      width: '700px',
                      maxWidth: '100%',
                      padding: '12px 16px',
                      marginBottom: '16px',
                      background: '#F5F7FA',
                      borderRadius: '6px',
                      display: 'flex',
                      gap: '24px',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      fontSize: '15px',
                    }}
            >
              <span>
                <strong>Country:</strong> {savedCountry}
              </span>

              {savedCounty && (
              <span>
                <strong>County:</strong> {savedCounty}
              </span>
                  )}

              <span style={{ marginLeft: 'auto' }}>
                <strong>Configured Holidays:</strong> {holidays.length}
              </span>
            </div>

            {/* Holiday List */}
            <div
              style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                    }}
            >
              {holidays.map((h) => (
                <div
                  key={`${h.date}-${h.name}`}
                  style={{
                            width: '700px',
                            maxWidth: '100%',
                            padding: '12px 16px',
                            background: '#FAFBFC',
                            borderLeft: '4px solid #167DFF',
                            borderRadius: '4px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                >
                  <span
                    style={{
                      fontSize: '16px',
                      fontWeight: 500,
                    }}
                  >
                    {h.name}
                  </span>

                  <span
                    style={{
                              color: '#6B7280',
                              fontSize: '18px',
                            }}
                  >
                    {h.date}
                  </span>
                </div>
                  ))}
            </div>
          </>
          )}
      </Panel>
    </div>
  );
};

export const App = memo(HolidaysWidget);

