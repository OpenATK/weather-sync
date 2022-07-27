//@ts-nocheck
/**
 * @license
 *  Copyright 2021 Qlever LLC
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Load config first so it can set up env
import config from './config.js';

import moment, { Moment } from 'moment';
import _ from 'lodash';
import debug from 'debug';
import esMain from 'es-main';
//@ts-ignore
import wp from 'weather-prism'
import sr from 'solar-rad';

import { JsonObject, OADAClient, connect } from '@oada/client';
import { ListWatch } from '@oada/list-lib';
import type { TreeKey } from '@oada/list-lib/dist/tree.js';
import poll from '@oada/poll';
//@ts-ignore
import ngh from 'ngeohash';

import {watchAois, watchAoiList} from './aoiHandler.js'
import tree from './tree.js';

const solarApiKey = config.get('service.solarApiKey');
const solarEmail = config.get('service.solarEmail');
const { token, domain } = config.get('oada');
const { interval } = config.get('service');
const SERVICE_PATH = `/bookmarks/weather`;
//const gridPath = `/bookmarks/weather/geohash-index`;
const locationPath = `/bookmarks/weather/location-index`;
const weatherPath = `/bookmarks/weather/acis/geohash-index`;
const solarPath = `/bookmarks/weather/nsrdb-psmv3/geohash-index`;
const dataPath = `/bookmarks/weather`;
const currentDate = config.get('service.currentDate');

const info = debug('sswabjs-service:info');
const trace = debug('sswabjs-service:trace');
const error = debug('sswabjs-service:error');

let oada: OADAClient;
let polling = false;

/**
 * watches for registered grid cells
 */
export async function watchWeatherGrid(oada: OADAClient) {
  const watch = new ListWatch({
    path: weatherPath,
    name: `weather-sync`,
    conn: oada,
    resume: true,
    async onAddItem(_, id) { await onAddWeatherGrid(oada, id)},
  });
  process.on('beforeExit', async () => {
    await watch.stop();
  });
  info(`watchWeatherGrid watching for changes at ${weatherPath}`)
  return watch;
} // watchWeatherGrid

/**
 * Geohash added. Fill out the data
 */
export async function onAddWeatherGrid(oada: OADAClient, path: string) {
  let geohash = path.replace(/^\//, '');
  trace(`onAddWeatherGrid detected new geohash: ${geohash}`)
  //1. Get the grid location
  let latlon = ngh.decode(geohash)

  let sdate = '2000-01-01';
  let edate = currentDate;

  //2. Find the grid location
  let {data, template} = await wp.get(latlon.longitude, latlon.latitude, sdate, edate);
  trace(`onAddWeatherGrid fetched data from weather-prism: ${sdate} - ${edate}`)

  let yearIndexed = {}
  Object.entries(data).forEach(([key, value]) => {
    let year = key.substr(0,4);
    yearIndexed[year] = yearIndexed[year] || {};
    yearIndexed[year][key] = value;
  })

  await oada.put({
    path: `${weatherPath}/${geohash}`,
    tree,
    data: {
      template
    }
  })
  for await (let year of Object.keys(yearIndexed)) {
    trace(`onAddWeatherGrid writing year ${year} to grid ${geohash}`);
    await oada.put({
      path: `${weatherPath}/${geohash}/year-index/${year}`,
      tree,
      data: {
        "day-index": yearIndexed[year]
      }
    })
  }
  info(`onAddWeatherGrid finished writing data to geohash ${geohash}`)
}

/**
 * watches for registered grid cells
 */
export async function watchSolarGrid(oada: OADAClient) {
  const watch = new ListWatch({
    path: solarPath,
    name: `solar-sync`,
    conn: oada,
    resume: true,
    async onAddItem(_, id) {
      await onAddSolarGrid(oada, id)
    },
  });
  process.on('beforeExit', async () => {
    await watch.stop();
  });
  info(`watchSolarGrid watching for changes at ${solarPath}`)
  return watch;
} // watchSolarGrid

/**
 * Geohash added. Get the corresponding NSRDB grid location
 */
export async function onAddSolarGrid(oada: OADAClient, path: string) {
  try {
  let geohash = path.replace(/^\//, '');
  trace(`onAddSolarGrid detected new geohash: ${geohash}`)
  //1. Get the grid location
  let latlon = ngh.decode(geohash)

  let syear = 2000;
  let eyear = parseInt(currentDate.substr(0, 4));
  let years = _.range(syear, eyear+1);

  //2. Find the grid location
  let {data, template} = await sr.fetch({
    lat: latlon.latitude,
    lon: latlon.longitude,
    years,
    api_key: solarApiKey,
    email: solarEmail
  });
  data = sr.aggregate(data, 'daily');
  trace(`onAddSolarGrid fetched data from solar-rad: ${syear} - ${eyear}`)

  let yearIndexed = {}
  Object.entries(data).forEach(([key, value]) => {
    let year = key.substr(0,4);
    yearIndexed[year] = yearIndexed[year] || {};
    yearIndexed[year][key] = value;
  })

  await oada.put({
    path: `${weatherPath}/${geohash}`,
    tree,
    data: {
      template
    }
  })

  for await (let year of Object.keys(yearIndexed)) {
    trace(`onAddSolarGrid writing year ${year} to grid ${geohash}`);
    await oada.put({
      path: `${solarPath}/${geohash}/year-index/${year}`,
      tree,
      data: {
        "day-index": yearIndexed[year]
      }
    })
  }
  info(`onAddSolarGrid finished writing data to geohash ${geohash}`)
  } catch(err) {
    console.log(err);
  }
}

/**
 * The callback to be used by the poller to execute the weather polling.
 */
export async function pollWeather(lastPoll: Moment, end: Moment) {
  const startTime = (lastPoll || moment('20150101', 'YYYYMMDD')).utc().format();
  const endTime = end.utc().format();
  trace(`Fetching FL community members with start time: [${startTime}]`);
  trace(`Fetching FL community members with end time: [${endTime}]`);

  let locations = await oada.get({
    path: `${dataPath}/location-index`
  })

  for (const gh in locations) {
    info(`Polling data for location ${gh}`);
    let {lon, lat, lastDate } = await oada.get({
      path: `${dataPath}/location-index/${gh}`
    }).then(r => r.data as JsonObject)

    let startDate = lastDate;
    let endDate = currentDate;

    if (startDate) {
      await wp.get(lon, lat, startDate, endDate);
    } else {
      startDate = '2000-01-01'
      await wp.fetch({
        lon,
        lat,
        startDate
      })
    }
    await oada.get({
      path: `${dataPath}/location-index`
    }).then(r => r.data as JsonObject)
  }
}// PollFl

export function setConnection(conn: OADAClient) {
  oada = conn;
}

export async function initialize(){
  try {
    info(
      `<<<<<<<<<       Initializing weather-sync service. [v0.0.1]       >>>>>>>>>>`
    );
    // Connect to oada
    oada = await connect({ token, domain: `https://${domain}` });

    await oada.get({
      path: `${SERVICE_PATH}`,
    })
    .then((r:any) => r.data as JsonObject)
    .catch(async (cError: any) => {
      if (cError.status === 404) {
        await oada.put({
          path: `${SERVICE_PATH}`,
          data: {},
          tree,
        })
        return {} as JsonObject;
      }
      throw cError;
    });

    // Poll for weather data updates.
    if (polling === undefined || polling) {
      await poll.poll({
        connection: oada,
        basePath: SERVICE_PATH,
        pollOnStartup: true,
        pollFunc: pollWeather,
        interval: interval,
        name: 'weather-sync-poll',
        /*
        getTime: (async () => axios({
            method: 'head',
            url: `${FL_DOMAIN}/businesses`,
            headers: { Authorization: FL_TOKEN },
            }).then((r) => r.headers.date)) as unknown as () => Promise<string>
        */
      });
      info('Started weather-sync poller.');
    }

    await watchWeatherGrid();
    await watchSolarGrid();

    await watchAois(oada);
    await watchAoiList(oada);

    info('Initialize complete. Service running...');
  } catch (cError: unknown) {
    error(cError);
    throw cError;
  }
} // Initialize

/**
 * Simulate walking through time at an increased rate
 */
export async function simulator() {

}

process.on('uncaughtExceptionMonitor', (cError: unknown) => {
  error({ error: cError }, 'Uncaught exception');
  //The code can carry on for most of these errors, but I'd like to know about
  //them. If I throw, it causes more trouble so I won't.
//  throw cError;
});

if (esMain(import.meta)) {
  info('Starting up the service. Calling initialize');
  await initialize()
} else {
  info('Just importing weather-sync');
}
