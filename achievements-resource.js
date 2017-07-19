'use strict';
var async = require('bluebird').coroutine;
var UserService = require('lib/user-service');
var get = require('lib/get');
var ErrorHandler = require('lib/errors/error-handler');
var UserService = require('lib/user-service');
var AchievementService = require('lib/achievements/achievement-service'); 
var _ = require('underscore');
var i18n = require('lib/i18n');
var newsFeedUtils = require('lib/newsfeed').Utils;
var Config = require('lib/config');
var CryptoJS = require("crypto-js");
var Replacer = require('lib/template-replacer').replacer;

const LIMIT = 15;

var createSocialRef = async(function* (data, user) {
  
  var subject = yield Replacer(data.subject, user.locale, user.installId);
  var textLong = yield Replacer(data.textLong, user.locale, user.installId);
  var imageUrl = yield Replacer(data.imageUrl, user.locale, user.installId);
  
  return CryptoJS.AES.encrypt(JSON.stringify({ subject, textLong, imageUrl }), Config.shareRefSecret).toString();
  
});


var addSocialRef = async(function* (achievement, user) {
  achievement.socialRef = yield createSocialRef({
    subject: achievement.shareSubject,
    textLong: achievement.shareTextLong,
    imageUrl: achievement.shareImageUrl
  }, user); 
  return achievement;
});

var achievementMapper = function (achievement) {
  if (/^badge_.+/g.test(achievement.achievementId)) //Added to remove progress of this kind of achievement
    achievement.currentSteps = (achievement.currentSteps === achievement.totalSteps) ? achievement.currentSteps : 0;
  achievement.currentSteps = achievement.currentSteps || 0;
  achievement.imageUrl = achievement.currentSteps === achievement.totalSteps ? achievement.imageUnlocked : achievement.imageRevealed;
  achievement.description = achievement.currentSteps === achievement.totalSteps ? achievement.descriptionUnlocked : achievement.descriptionRevealed;
  achievement.actions = (achievement.actions || '').split(',');
  achievement.data = achievement.data || '{}';
  return {
    achievementId: achievement.achievementId,
    name: achievement.name,
    description: achievement.description,
    currentSteps: achievement.currentSteps,
    totalSteps: achievement.totalSteps,
    color: achievement.color,
    imageUrl: achievement.imageUrl,
    lastUpdated: achievement.lastUpdated,
    actions: achievement.actions,
    data: achievement.data
  };
};

var formatFriendsAchievement = function (achievementResult) {
  
  var imageUrl = achievementResult.imageRevealed;
  var description = achievementResult.descriptionRevealed; 
  if (achievementResult.currentSteps === achievementResult.totalSteps) {
    imageUrl = achievementResult.imageUnlocked;
    description = achievementResult.descriptionUnlocked;
  }
       
  return {
    achievement:  {
      achievementId: achievementResult.achievementId,
      name: achievementResult.name,
      description: description,
      currentSteps: achievementResult.currentSteps,
      totalSteps: achievementResult.totalSteps,
      color: achievementResult.color,
      imageUrl: imageUrl,
      lastUpdated: achievementResult.lastUpdated,
      actions: (achievementResult.actions || '').split(','),
      data: achievementResult.data || '{}'
    }, 
    badgeProfile: {
      profileId: 'a' + achievementResult.accountId,
      badgeImageUrl: `https://graph.facebook.com/${ achievementResult.providerAccountId }/picture?type=normal`
    }
  };
};

var formatFeatureProfile = function (achievementResult) {
  return {
    profileId: 'a' + achievementResult.accountId,
    firstname: achievementResult.firstname,
    lastname: achievementResult.lastname,
    profileImageUrl: `https://graph.facebook.com/${ achievementResult.providerAccountId }/picture?type=normal`,
    badgeAchievement: {
      achievementId: achievementResult.badgeAchievementId,
      badgeImageUrl: achievementResult.badgeAchievementImage
    }
  };
};

var AchievementsResource = {
  getAchievements: async(function*(req, res) {
    
    try {
      var userHash = get(req.params, 'userHash').expectToExist().orThrow();
      var user = yield UserService.getUserByHash(userHash);
      
      var versionAsANumber = 0;
      if (user.version) versionAsANumber = Number(user.version.split('.').join(''));
      var limit = LIMIT;
      limit = (versionAsANumber < 304 && user.platform === 'android') ? 3 : limit;
      limit = (versionAsANumber < 305 && user.platform === 'ios') ? 6 : limit;
      
      var achievements = yield AchievementService.getAchievementsByUserAsync(user);
      
      var badgeAchievements = achievements.filter(function(achievement) {
        return /^badge_.+/g.test(achievement.achievementId);
      })
      .sort(function(achievementA, achievementB) {
        return achievementB.totalSteps - achievementA.totalSteps;
      });
      
      badgeAchievements = badgeAchievements.slice(0, 2); //badgeAchievements to show for this user
        
      achievements = achievements.sort(function(achievementA, achievementB) { 
                    return achievementB.orderNumber - achievementA.orderNumber; //TODO: This could be send to the db query
                  })
                  .filter(function(achievement) { //removes badgeAchievements
                    return (!/^badge_.+/g.test(achievement.achievementId) || _.contains(badgeAchievements, achievement));
                  })
                  .map(achievementMapper);
      
      var featuredAchievements = [];
      
      for (let count = 0; count < achievements.length; count++) {
        let result = achievements[count];
        if (result.currentSteps < result.totalSteps &&  result.actions.some(function(action){ return action.toLowerCase().includes("donate"); })) {
          featuredAchievements.push(achievements.splice(count, 1)[0]); // Moved element from results to featuredAchievements
          break;
        } // END if
      } // END for

      for (let count = 0; count < achievements.length; count++) {
        let result = achievements[count];
        if (result.currentSteps < result.totalSteps &&  !  result.actions.some(function(action){ return action.toLowerCase().includes("donate"); })) {
          featuredAchievements.push(achievements.splice(count, 1)[0]); // Moved element from results to featuredAchievements
          break;
        } // END if
      } // END for
      
      var recentAchievementsByNoFriends = [];
      
      if (user.accountId) {
        var friendIds = yield UserService.getAccountIdsBefriendedWith(user.accountId);
        var recentAchievements  = yield AchievementService.getFriendsWithAchievementsByAccountIdAsync(friendIds, null, user.locale);
        if (recentAchievements.length < limit) {
          friendIds.push(user.accountId);
          recentAchievementsByNoFriends = yield AchievementService.getPeopleWithAchievementsByExcludingAccountIdAsync(friendIds, null, user.locale, limit - recentAchievements.length);
          recentAchievements = recentAchievements.concat(recentAchievementsByNoFriends);
        }
        
        res.status(200).json({
          featuredAchievements: featuredAchievements,
          userAchievements: achievements,
          recentAchievements: recentAchievements.map(formatFriendsAchievement)
        });
      
      } else { // END if (user.accountId)
        recentAchievementsByNoFriends = yield AchievementService.getPeopleWithAchievementsByExcludingAccountIdAsync([], null, user.locale, limit); //TODO remove obsolete parameter and simplify query
        
        res.status(200).json({
          featuredAchievements: featuredAchievements,
          userAchievements: achievements,
          recentAchievements: recentAchievementsByNoFriends.map(formatFriendsAchievement)
        });
      }
      
    } catch (err) {
      ErrorHandler(err, res);
    }
  }),

  getAchievement: async(function*(req, res) {
    
    try {
      
      var userHash = get(req.params, 'userHash').expectToExist().orThrow();
      var user = yield UserService.getUserByHash(userHash);
      var achievementId = get(req.params, 'achievementId').expectToExist().orThrow();
      
      var versionAsANumber = 0;
      if (user.version) versionAsANumber = Number(user.version.split('.').join(''));
      var limit = LIMIT;
      limit = (versionAsANumber < 304 && user.platform === 'android') ? 3 : limit;
      limit = (versionAsANumber < 305 && user.platform === 'ios') ? 6 : limit;
      
      var results = yield Promise.all([
        AchievementService.getAchievementByAchievementIdAsync(achievementId, user.locale),
        AchievementService.getAchievementByUserAndAchievementId(user, achievementId)
      ]);
      
      var requestedAchievement = results[0];
      var userAchievement = results[1];
      var featuredProfiles = [];
      
      var promises = [];
      
      if (user.accountId) {
        var friendIds = yield UserService.getAccountIdsBefriendedWith(user.accountId);
        promises.push(AchievementService.getFriendsWithAchievementsByAccountIdAsync(friendIds, achievementId, user.locale));
        if (featuredProfiles.length < limit) {
          friendIds.push(user.accountId);
          promises.push(AchievementService.getPeopleWithAchievementsByExcludingAccountIdAsync(friendIds, achievementId, user.locale, limit - featuredProfiles.length));//this one
        }
      } else {
        promises.push(yield AchievementService.getPeopleWithAchievementsByExcludingAccountIdAsync([], achievementId, user.locale, limit)); //TODO remove obsolete parameter and simplify query
      }
      
      results = yield Promise.all(promises);
      
      for (let i of results)
        featuredProfiles = featuredProfiles.concat(i);
      
      featuredProfiles = featuredProfiles.map(formatFeatureProfile);
      
      userAchievement = userAchievement || { currentSteps : 0, lastUpdatedTimestamp : null };
      
      var isAchievementUnlocked = userAchievement.currentSteps === userAchievement.totalSteps;
      
      var imageUrl = (isAchievementUnlocked) ? requestedAchievement.imageUnlocked : requestedAchievement.imageRevealed;
      var description = (isAchievementUnlocked) ? requestedAchievement.descriptionUnlocked : requestedAchievement.descriptionRevealed;
      
      var resultingAchievement = {
        achievementId: achievementId,
        name: requestedAchievement.name,
        description: description,
        currentSteps: userAchievement.currentSteps || 0,
        totalSteps: requestedAchievement.totalSteps,
        color: requestedAchievement.color,
        imageUrl: imageUrl,
        lastUpdated: userAchievement.lastUpdated,
        actions: (requestedAchievement.actions) ? requestedAchievement.actions.split(',') : [],
        data: requestedAchievement.data || '{}'
      };
      if (!_.contains(resultingAchievement.actions, 'SocialShare')) {
        resultingAchievement.actions.push('SocialShare');
      }
      
      var socialShare = {
        subject: i18n().get("socialShare.tellafriend.subject", user.locale),
        textLong: i18n().get("socialShare.tellafriend.instantLong", user.locale),
        textShort: i18n().get("socialShare.tellafriend.instantShort", user.locale),
        imageUrl: i18n().get("socialShare.tellafriend.imageUrl", user.locale),
        contentUrl: 'https://sharethemeal.org/now/?adjust_t=1yw41b'
      };
      
      socialShare.socialRef = yield createSocialRef({
        subject: socialShare.subject,
        textLong: socialShare.textLong,
        imageUrl: socialShare.imageUrl
      }, user); 
      
      var achievementUnlockedText = null;
      
      if (isAchievementUnlocked) {
        socialShare = {
          subject: requestedAchievement.shareSubject || i18n().get("socialShare.achievement.subject", user.locale),
          textLong: (requestedAchievement.shareTextLong || i18n().get("socialShare.achievement.instantLong", user.locale)).replace(new RegExp("{AchievementName}", "ig"), requestedAchievement.name),
          textShort: (requestedAchievement.shareTextShort || i18n().get("socialShare.achievement.instantShort", user.locale)).replace(new RegExp("{AchievementName}", "ig"), requestedAchievement.name),
          imageUrl: requestedAchievement.shareImageUrl || i18n().get("socialShare.achievement.imageUrl", user.locale),
          contentUrl: 'https://sharethemeal.org/now/?adjust_t=1va3ou'
        };
        
        socialShare.socialRef = yield createSocialRef({
          subject: socialShare.subject,
          textLong: socialShare.textLong,
          imageUrl: socialShare.imageUrl
        }, user);
        
        var placeholders = {};
        var locoKey = 'youunlocked.noname.text';

        if (user.accountId && user.firstname) {
          placeholders.userName = '<b>' + user.firstname + '</b>';
          locoKey = 'youunlocked.named.text';
        }
          
        achievementUnlockedText = newsFeedUtils.getFeedText(
          user.locale,
          locoKey, 
          'i' + user.installId + '_' + resultingAchievement.achievementId,
          placeholders
        );
      
      }
      
      res.status(200).json({
        achievement: resultingAchievement,
        featuredProfiles: featuredProfiles,
        socialShare: socialShare,
        achievementUnlockedText: achievementUnlockedText
      });
      
    } catch (err) {
      ErrorHandler(err, res);
    }
    
  })};

module.exports = AchievementsResource;
