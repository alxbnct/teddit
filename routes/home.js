const config = require('../config');
const { redis, fetch } = require('../app');
const homeRoute = require('express').Router();

const processJsonSubreddit = require('../inc/processJsonSubreddit.js');
const tedditApiSubreddit = require('../inc/teddit_api/handleSubreddit.js')();
const processMoreComments = require('../inc/processMoreComments.js')();

homeRoute.get('/:sort?', async (req, res, next) => {
  let past = req.query.t;
  let before = req.query.before;
  let after = req.query.after;
  let sortby = req.params.sort || '';
  let api_req = req.query.api;
  let api_type = req.query.type;
  let api_target = req.query.target;

  let proxyable =
    sortby.includes('.jpg') ||
    sortby.includes('.png') ||
    sortby.includes('.jpeg')
      ? true
      : false;
  if (proxyable) {
    let params = new URLSearchParams(req.query).toString();
    let image_url = `https://preview.redd.it/${sortby}?${params}`;
    let proxied_image = await downloadAndSave(image_url);
    if (proxied_image) {
      return res.redirect(proxied_image);
    } else {
      return res.redirect('/');
    }
  }

  let d = `&after=${after}`;
  if (before) {
    d = `&before=${before}`;
  }

  if (sortby == '') {
    sortby = 'hot';
  }

  if (
    [
      'apple-touch-icon.png',
      'apple-touch-icon-precomposed.png',
      'apple-touch-icon-120x120.png',
      'apple-touch-icon-120x120-precomposed.png',
    ].includes(sortby)
  ) {
    return res.sendStatus(404); // return 404 on shitty apple favicon stuff
  }

  if (
    !['new', 'rising', 'controversial', 'top', 'gilded', 'hot'].includes(sortby)
  ) {
    console.log(`Got invalid sort.`, req.originalUrl);
    return res.redirect('/');
  }

  if (past) {
    if (sortby === 'controversial' || sortby === 'top') {
      if (!['hour', 'day', 'week', 'month', 'year', 'all'].includes(past)) {
        console.error(`Got invalid past.`, req.originalUrl);
        return res.redirect(`/`);
      }
    } else {
      past = undefined;
    }
  } else {
    if (sortby === 'controversial' || sortby === 'top') {
      past = 'day';
    }
  }

  if (req.query.hasOwnProperty('api')) api_req = true;
  else api_req = false;

  let raw_json = api_req && req.query.raw_json == '1' ? 1 : 0;

  let key = `/after:${after}:before:${before}:sort:${sortby}:past:${past}:raw_json:${raw_json}`;

  let subbed_subreddits = req.cookies.subbed_subreddits;
  let get_subbed_subreddits = false;
  if (subbed_subreddits && Array.isArray(subbed_subreddits)) {
    get_subbed_subreddits = true;
    subbed_subreddits = subbed_subreddits.join('+');
    key = `${subbed_subreddits.toLowerCase()}:${after}:${before}:sort:${sortby}:past:${past}:raw_json:${raw_json}`;
  }

  redis.get(key, (error, json) => {
    if (error) {
      console.error('Error getting the frontpage key from redis.', error);
      return res.render('index', {
        json: null,
        user_preferences: req.cookies,
      });
    }
    if (json) {
      console.log('Got frontpage key from redis.');
      (async () => {
        if (api_req) {
          return handleTedditApiSubreddit(
            json,
            req,
            res,
            'redis',
            api_type,
            api_target,
            '/'
          );
        } else {
          let processed_json = await processJsonSubreddit(
            json,
            'redis',
            null,
            req.cookies
          );
          return res.render('index', {
            json: processed_json,
            sortby: sortby,
            past: past,
            user_preferences: req.cookies,
            redis_key: key,
          });
        }
      })();
    } else {
      let url = '';
      if (config.use_reddit_oauth) {
        if (get_subbed_subreddits)
          url = `https://oauth.reddit.com/r/${subbed_subreddits}/${sortby}?api_type=json&count=25&g=GLOBAL&t=${past}${d}&raw_json=${raw_json}`;
        else
          url = `https://oauth.reddit.com/${sortby}?api_type=json&g=GLOBAL&t=${past}${d}&raw_json=${raw_json}`;
      } else {
        if (get_subbed_subreddits)
          url = `https://reddit.com/r/${subbed_subreddits}/${sortby}.json?api_type=json&count=25&g=GLOBAL&t=${past}${d}&raw_json=${raw_json}`;
        else
          url = `https://reddit.com/${sortby}.json?g=GLOBAL&t=${past}${d}&raw_json=${raw_json}`;
      }
      fetch(encodeURI(url), redditApiGETHeaders())
        .then((result) => {
          if (result.status === 200) {
            result.json().then((json) => {
              redis.setex(
                key,
                config.setexs.frontpage,
                JSON.stringify(json),
                (error) => {
                  if (error) {
                    console.error(
                      'Error setting the frontpage key to redis.',
                      error
                    );
                    return res.render('index', {
                      json: null,
                      user_preferences: req.cookies,
                    });
                  } else {
                    console.log('Fetched the frontpage from Reddit.');
                    (async () => {
                      if (api_req) {
                        return handleTedditApiSubreddit(
                          json,
                          req,
                          res,
                          'from_online',
                          api_type,
                          api_target,
                          '/'
                        );
                      } else {
                        let processed_json = await processJsonSubreddit(
                          json,
                          'from_online',
                          null,
                          req.cookies
                        );
                        return res.render('index', {
                          json: processed_json,
                          sortby: sortby,
                          past: past,
                          user_preferences: req.cookies,
                          redis_key: key,
                        });
                      }
                    })();
                  }
                }
              );
            });
          } else {
            console.error(
              `Something went wrong while fetching data from Reddit. ${result.status} – ${result.statusText}`
            );
            console.error(config.reddit_api_error_text);
            return res.render('index', {
              json: null,
              http_status_code: result.status,
              user_preferences: req.cookies,
            });
          }
        })
        .catch((error) => {
          console.error('Error fetching the frontpage JSON file.', error);
        });
    }
  });
});

module.exports = homeRoute;