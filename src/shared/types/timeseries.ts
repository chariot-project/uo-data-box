import {Model, Transaction} from 'objection';

import {fuzzyName, uriName} from 'shared/controllers/formatters';
import {cacheResource} from 'shared/drivers/cache';
import {RequestDetail, StorageBase, SQL} from 'shared/drivers/sql';
import {log} from 'shared/services/log';
import {generateLinks} from 'shared/services/hateoas';

import {Feed, Entity} from './';
import {Aggregation} from './aggregation';
import {Assessment} from './assessment';
import {Derivative} from './derivative';
import {Unit, UnitProperties} from './unit';
import {Storage, StorageProperties} from './storage';
import {Data, DataProperties} from './data';

export interface TimeseriesProperties {
  timeseriesId?: string;
  timeseriesNum?: number;
  feedId?: string;
  storageId?: number;
  aggregation?: Aggregation[];
  derivatives?: Derivative[];
  assessments?: Assessment[];
  unitId?: string;
  unit?: UnitProperties;
  storage?: StorageProperties;
}

@cacheResource({
  expiration: 3600,
  uniqueId: 'timeseriesId'
})
export class Timeseries extends StorageBase {
  static tableName: string = SQL.TableName('timeseries');
  static idColumn: string = 'timeseries_id';
  static defaultEager: string = `
    unit,
    storage,
    aggregation,
    derivatives,
    assessments
  `;

  // Table attributes
  public timeseriesId: string;
  public timeseriesNum: number;
  public feedId: string;
  public storageId: number;
  public unit: Unit;
  public aggregation: Aggregation[];
  public derivatives: Derivative[];
  public assessments: Assessment[];
  public storage: Storage;

  // Table relations
  static relationMappings = {
    unit: {
      relation: Model.HasOneRelation,
      modelClass: Unit,
      join: {
        from: `${SQL.TableName('timeseries')}.unit_id`,
        to: `${SQL.TableName('unit')}.unit_id`
      }
    },
    storage: {
      relation: Model.HasOneRelation,
      modelClass: Storage,
      join: {
        from: `${SQL.TableName('timeseries')}.storage_id`,
        to: `${SQL.TableName('storage')}.storage_id`
      }
    },
    aggregation: {
      relation: Model.ManyToManyRelation,
      modelClass: Aggregation,
      join: {
        from: `${SQL.TableName('timeseries')}.timeseries_id`,
        through: {
          from: `${SQL.TableName('timeseries_aggregation')}.timeseries_id`,
          to: `${SQL.TableName('timeseries_aggregation')}.aggregation_id`,
        },
        to: `${SQL.TableName('aggregation')}.aggregation_id`
      }
    },
    derivatives: {
      relation: Model.ManyToManyRelation,
      modelClass: Derivative,
      join: {
        from: `${SQL.TableName('timeseries')}.timeseries_id`,
        through: {
          from: `${SQL.TableName('timeseries_derivative')}.timeseries_id`,
          to: `${SQL.TableName('timeseries_derivative')}.derivative_id`,
        },
        to: `${SQL.TableName('derivative')}.derivative_id`
      }
    },
    assessments: {
      relation: Model.ManyToManyRelation,
      modelClass: Assessment,
      join: {
        from: `${SQL.TableName('timeseries')}.timeseries_id`,
        through: {
          from: `${SQL.TableName('timeseries_assessment')}.timeseries_id`,
          to: `${SQL.TableName('timeseries_assessment')}.assessment_id`,
        },
        to: `${SQL.TableName('assessment')}.assessment_id`
      }
    }
  };

  public static async assert(t: TimeseriesProperties, trx?: Transaction, instance?: Timeseries): Promise<any> {
    const timeseriesId = t.timeseriesId || (instance && instance.timeseriesId);
    let timeseries: Timeseries;

    const unit = await Unit.assert(
      t.unit,
      trx,
      instance && instance.unit && instance.unit.isEquivalent(t.unit) && instance.unit
    );
    const storage = await Storage.assert(
      t.storage,
      trx,
      instance && instance.storage && instance.storage.isEquivalent(t.storage) && instance.storage
    );

    // Unit ID may change, which is a special case as we don't change the units,
    // we add new ones
    if (instance && (instance.unit && instance.unit.unitId !== unit.unitId || !instance.unit)) {
      t.unitId = unit.unitId;
    }
    // Storage ID may change, but that would be so weird... let's try not to
    if (instance && (instance.storage && instance.storage.storageId !== storage.storageId || !instance.storage)) {
      t.storageId = storage.storageId;
    }

    if (!timeseriesId) {
      timeseries = await this.create({...t, unitId: unit.unitId, storageId: storage.storageId}, trx);
    }

    if (!instance && t.timeseriesId) {
      instance = await Timeseries.getById(t.timeseriesId, trx);
    }

    if (instance && instance.shouldPatch(t)) {
      await this.query(trx)
        .skipUndefined()
        .patch(instance.$formatDatabaseJson(<any>{...t}))
        .where({
          timeseries_id: instance.timeseriesId
        });
      timeseries = await Timeseries.getById(instance.timeseriesId, trx);
    }

    return timeseries || instance;
  }

  public static async create(t: TimeseriesProperties, trx?: Transaction): Promise<any> {
    const timeseries = await this.query(trx)
      .insert(<any>{
        feed_id: t.feedId,
        unit_id: t.unitId,
        storage_id: t.storageId
      });
    return timeseries;
  }

  public static async getByFriendlyNames(entityName: string, metric: string, timeseries: string, trx?: Transaction): Promise<Timeseries> {
    // Currently we only have 'raw' timeseries so discount all other requests
    if (timeseries !== 'raw') return undefined;

    const set = await this.namedQuery(`Get timeseries with fuzzy entity '${entityName}' and metric '${metric}' and timeseries '${timeseries}'`, trx)
      .where('feed_id', '=', Feed.query()
        .select('feed_id')
        .where('metric', '~*', fuzzyName(metric))
        .andWhere('entity_id', '=', Entity.query()
          .select('entity_id')
          .where('name', '~*', fuzzyName(entityName))
          .limit(1))
      )
      .eager(`[ ${Timeseries.defaultEager} ]`)
      .modifyEager('service', builder => {
        builder.orderBy('time', 'desc').limit(1);
      });
    return Array.isArray(set) && set.length ? set[0] : undefined;
  }

  public static async getById(timeseriesId: string, trx?: Transaction): Promise<Timeseries> {
    return await this.namedQuery(`Get timeseries with the ID '${timeseriesId}'`, trx)
      .findOne({timeseries_id: timeseriesId})
      .eager(`[ ${this.defaultEager} ]`);
  }

  public isEquivalent(o: TimeseriesProperties) {
    if (super.isEquivalent(o)) {
      return true;
    }

    // Will also need to check the aggregates, derivatives and other stuff when we add
    // them.

    return true;
  }

  public async toFilteredJSON(parent?: any, excludeLatest: boolean = false, windDirection: 'up' | 'down' = 'down', requestDetail: RequestDetail = {}): Promise<any> {
    const baseJSON: any = {
      ...this.toJSON()
    };
    delete baseJSON.timeseriesNum;
    delete baseJSON.storageId;
    delete baseJSON.unitId;

    // Only include parent feed if we're traversing up the tree
    const parentFeed = windDirection === 'up' ?
      await (await Feed.getById(this.feedId)).toFilteredJSON(null, 'up', requestDetail) :
      undefined;

    const links = generateLinks([
      {
        href: `/sensors/timeseries/${this.timeseriesId}`,
        rel: 'self'
      },
      {
        href: `/sensors/timeseries/${this.timeseriesId}/historic`,
        rel: 'archives'
      },
      {
        href: `/sensors/timeseries/${uriName(
          [
            ((parentFeed || parent || {}).parentEntity || {}).name,
            (parentFeed || parent || {}).metric,
            'raw'
          ]
        )}`,
        rel: 'self.friendly'
      },
      {
        href: `/sensors/timeseries/${uriName(
          [
            ((parentFeed || parent || {}).parentEntity || {}).name,
            (parentFeed || parent || {}).metric,
            'raw',
            'historic'
          ]
        )}`,
        rel: 'archives.friendly'
      }
    ]);

    if (parent) {
      delete baseJSON.feedId;
    }

    const DataHandler = Data[this.storage.name];
    let latestObs = !excludeLatest && await DataHandler.getMostRecent(this.timeseriesId);

    if (!latestObs) {
      return Promise.resolve({
        ...baseJSON,
        parentFeed,
        links,
        storage: {
          ...baseJSON.storage,
          storageId: undefined
        }
      });
    } else {
      latestObs = DataHandler.prototype.toOutput.call(latestObs);
    }

    if ((parentFeed && parentFeed.isRestricted === true) || (!parentFeed && parent && parent.isRestricted === true)) { // Use stored value, not calling function
      log.verbose(`Disallowing access to latest readings for timeseries '${this.timeseriesId}'.`);
      return Promise.resolve({
        ...baseJSON,
        parentFeed,
        latest: {
          error: true,
          message: 'Access denied',
          description: 'The licence associated with the parent feed does not allow you access to observed values.'
        }
      });
    }

    return Promise.resolve({
      ...baseJSON,
      parentFeed,
      latest: {
        time: latestObs.time,
        duration: latestObs.duration,
        value: latestObs.value
      },
      links
    });
  }

  public async getHistoric(startTime?: Date, endTime?: Date, requestDetail?: RequestDetail): Promise<any> {
    const tsJSON = await this.toFilteredJSON(undefined, true, 'up', requestDetail);
    const DataHandler = Data[this.storage.name];
    const historicObs = await DataHandler.getHistoric(this.timeseriesNum, startTime, endTime);
    return Promise.resolve({
      timeseries: tsJSON,
      historic: historicObs
    });
  }
}
