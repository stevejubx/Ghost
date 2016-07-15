// # Update Database
// Handles migrating a database between two different database versions
var Promise = require('bluebird'),
    backup = require('./backup'),
    fixtures = require('./fixtures'),
    errors = require('../../errors'),
    i18n = require('../../i18n'),
    db = require('../../data/db'),
    sequence = require('../../utils/sequence'),
    versioning = require('../schema').versioning,

    updateDatabaseSchema,
    migrateToDatabaseVersion,
    update, logger;

// @TODO: remove me asap!
logger = {
    info: function info(message) {
        errors.logComponentInfo('Migrations', message);
    },
    warn: function warn(message) {
        errors.logComponentWarn('Skipping Migrations', message);
    }
};

/**
 * update database schema for one single version
 */
updateDatabaseSchema = function (tasks, logger, modelOptions) {
    if (!tasks.length) {
        return Promise.resolve();
    }

    return sequence(tasks, modelOptions, logger);
};

/**
 * update each database version as one transaction
 * if a version fails, rollback
 * if a version fails, stop updating more versions
 */
migrateToDatabaseVersion = function migrateToDatabaseVersion(version, logger, modelOptions) {
    return new Promise(function (resolve, reject) {
        db.knex.transaction(function (transaction) {
            var migrationTasks = versioning.getUpdateDatabaseTasks(version, logger),
                fixturesTasks = versioning.getUpdateFixturesTasks(version, logger);

            logger.info('###########');
            logger.info('Updating database to ' + version);
            logger.info('###########\n');

            modelOptions.transacting = transaction;

            updateDatabaseSchema(migrationTasks, logger, modelOptions)
                .then(function () {
                    return fixtures.update(fixturesTasks, logger, modelOptions);
                })
                .then(function () {
                    return versioning.setDatabaseVersion(transaction, version);
                })
                .then(function () {
                    transaction.commit();
                    resolve();
                })
                .catch(function (err) {
                    logger.warn('rolling back because of: ' + err.stack);

                    transaction.rollback();
                });
        }).catch(function () {
            reject();
        });
    });
};

/**
 * ## Update
 * Does a backup, then updates the database and fixtures
 */
update = function update(options) {
    options = options || {};

    var fromVersion = options.fromVersion,
        toVersion = options.toVersion,
        forceMigration = options.forceMigration,
        versionsToUpdate,
        modelOptions = {
            context: {
                internal: true
            }
        };

    // CASE: current database version is lower then we support
    if (fromVersion < versioning.canMigrateFromVersion) {
        return Promise.reject(new errors.DatabaseVersion(
            i18n.t('errors.data.versioning.index.cannotMigrate.error'),
            i18n.t('errors.data.versioning.index.cannotMigrate.context'),
            i18n.t('common.seeLinkForInstructions', {link: 'http://support.ghost.org/how-to-upgrade/'})
        ));
    }
    // CASE: the database exists but is out of date
    else if (fromVersion < toVersion || forceMigration) {
        fromVersion = forceMigration ? versioning.canMigrateFromVersion : fromVersion;

        // Figure out which versions we're updating through.
        // This shouldn't include the from/current version (which we're already on)
        versionsToUpdate = versioning.getMigrationVersions(fromVersion, toVersion).slice(1);

        return backup(logger)
            .then(function () {
                return Promise.mapSeries(versionsToUpdate, function (versionToUpdate) {
                    return migrateToDatabaseVersion(versionToUpdate, logger, modelOptions);
                });
            })
            .then(function () {
                logger.info('Finished!');
            });
    }
    // CASE: database is up-to-date
    else if (fromVersion === toVersion) {
        return Promise.resolve();
    }
    // CASE: we don't understand the version
    else {
        return Promise.reject(new errors.DatabaseVersion(i18n.t('errors.data.versioning.index.dbVersionNotRecognized')));
    }
};

module.exports = update;
