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
      <div className="widget">
        <h3>Fetch and Display Holidays</h3>
        <Panel className="form-panel">
          <Group>
            <Input
                value={inputCountry}
                onChange={(e) => setInputCountry(e.target.value)}
                placeholder="Country code (e.g. DE)"
            />
            <Input
                value={inputCounty}
                onChange={(e) => setInputCounty(e.target.value)}
                placeholder="County (optional e.g. DE-HE)"
            />
          </Group>
          <Group>
            <Button primary onClick={fetchHolidays}>Fetch Holidays</Button>
            <Button onClick={clearHolidays}>Clear Holidays</Button>
          </Group>
        </Panel>

        {message && <Text>{message}</Text>}

        <h4>Saved Holidays:</h4>
        {holidays.length === 0 && <Text>No holidays saved</Text>}
        {holidays.length > 0 && (
            <>
              <Text>
                Country: {savedCountry} {savedCounty ? `- County: ${savedCounty}` : ''}
              </Text>
              <ul>
                {holidays.map((h) => (
                    <li key={h.date}>
                      {h.date} — {h.name}
                    </li>
                ))}
              </ul>
            </>
        )}
      </div>
  );
};

export const App = memo(HolidaysWidget);

