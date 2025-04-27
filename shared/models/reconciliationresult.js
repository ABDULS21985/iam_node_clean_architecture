'use strict';

const { Model, Sequelize } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ReconciliationResult extends Model {
    /**
     * Define associations for ReconciliationResult.
     */
    static associate(models) {
      // Association: ReconciliationResult belongs to DiscoveryRun (required)
      this.belongsTo(models.DiscoveryRun, {
        foreignKey: {
          name: 'runId',
          allowNull: false
        },
        as: 'discoveryRun',
        onDelete: 'CASCADE'
      });

      // Association: ReconciliationResult belongs to User (optional)
      this.belongsTo(models.User, {
        foreignKey: {
          name: 'userId',
          allowNull: true
        },
        as: 'user',
        onDelete: 'SET NULL'
      });

      // Association: ReconciliationResult belongs to Application (optional)
      this.belongsTo(models.Application, {
        foreignKey: {
          name: 'applicationId',
          allowNull: true
        },
        as: 'application',
        onDelete: 'SET NULL'
      });
    }
  }

  ReconciliationResult.init(
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
        defaultValue: Sequelize.literal('uuid_generate_v4()')
      },
      runId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'DiscoveryRuns', // Important: match table name not model name
          key: 'id'
        }
      },
      discrepancyType: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'Type of discrepancy: Violation, MissingAccess, OrphanedAccount, etc.'
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'Users',
          key: 'id'
        }
      },
      applicationId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'Applications',
          key: 'id'
        }
      },
      appSpecificUserId: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'User identifier as recognized in external application (optional).'
      },
      appSpecificEntitlementId: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Entitlement identifier in external application (optional).'
      },
      details: {
        type: DataTypes.JSONB,
        allowNull: true,
        comment: 'Flexible metadata associated with the reconciliation result.'
      },
      timestamp: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        comment: 'Timestamp when the reconciliation result was detected.'
      }
    },
    {
      sequelize,
      modelName: 'ReconciliationResult',
      tableName: 'ReconciliationResults',
      timestamps: true, // Adds createdAt, updatedAt
      underscored: false, // Use camelCase
      indexes: [
        { fields: ['runId'], name: 'idx_reconciliationresults_runid' },
        { fields: ['userId'], name: 'idx_reconciliationresults_userid' },
        { fields: ['applicationId'], name: 'idx_reconciliationresults_applicationid' }
      ]
    }
  );

  return ReconciliationResult;
};
