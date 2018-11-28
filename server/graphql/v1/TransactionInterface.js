import { get } from 'lodash';
import models from '../../../server/models';
import {
  GraphQLInt,
  GraphQLFloat,
  GraphQLString,
  GraphQLInterfaceType,
  GraphQLObjectType,
  GraphQLList,
  GraphQLEnumType,
  GraphQLInputObjectType,
} from 'graphql';

import { CollectiveInterfaceType, UserCollectiveType } from './CollectiveInterface';

import { SubscriptionType, OrderType, PaymentMethodType, UserType } from './types';

export const TransactionInterfaceType = new GraphQLInterfaceType({
  name: 'Transaction',
  description: 'Transaction interface',
  resolveType: transaction => {
    switch (transaction.type) {
      case 'CREDIT':
        return TransactionOrderType;
      case 'DEBIT':
        return TransactionExpenseType;
      default:
        return null;
    }
  },
  fields: () => {
    return {
      id: { type: GraphQLInt },
      uuid: { type: GraphQLString },
      amount: { type: GraphQLInt },
      currency: { type: GraphQLString },
      hostCurrency: { type: GraphQLString },
      hostCurrencyFxRate: { type: GraphQLFloat },
      netAmountInCollectiveCurrency: { type: GraphQLInt },
      hostFeeInHostCurrency: { type: GraphQLInt },
      platformFeeInHostCurrency: { type: GraphQLInt },
      paymentProcessorFeeInHostCurrency: { type: GraphQLInt },
      createdByUser: { type: UserType },
      host: { type: CollectiveInterfaceType },
      paymentMethod: { type: PaymentMethodType },
      fromCollective: { type: CollectiveInterfaceType },
      usingVirtualCardFromCollective: { type: CollectiveInterfaceType },
      collective: { type: CollectiveInterfaceType },
      type: { type: GraphQLString },
      description: { type: GraphQLString },
      privateMessage: { type: GraphQLString },
      createdAt: { type: GraphQLString },
      updatedAt: { type: GraphQLString },
      refundTransaction: { type: TransactionInterfaceType },
    };
  },
});

const TransactionFields = () => {
  return {
    id: {
      type: GraphQLInt,
      resolve(transaction) {
        return transaction.id;
      },
    },
    refundTransaction: {
      type: TransactionInterfaceType,
      resolve(transaction) {
        if (transaction && transaction.getRefundTransaction) {
          return transaction.getRefundTransaction();
        }
        return null;
      },
    },
    uuid: {
      type: GraphQLString,
      resolve(transaction, args, req) {
        if (!req.remoteUser) {
          return null;
        }
        if (transaction && transaction.getDetailsForUser) {
          return transaction.getDetailsForUser(req.remoteUser);
        }
        return null;
      },
    },
    type: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.type;
      },
    },
    amount: {
      type: GraphQLInt,
      resolve(transaction) {
        return transaction.amount;
      },
    },
    currency: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.currency;
      },
    },
    hostCurrency: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.hostCurrency;
      },
    },
    hostCurrencyFxRate: {
      type: GraphQLFloat,
      description:
        'Exchange rate between the currency of the transaction and the currency of the host (transaction.amount * transaction.hostCurrencyFxRate = transaction.amountInHostCurrency)',
      resolve(transaction) {
        return transaction.hostCurrencyFxRate;
      },
    },
    hostFeeInHostCurrency: {
      type: GraphQLInt,
      description: 'Fee kept by the host in the lowest unit of the currency of the host (ie. in cents)',
      resolve(transaction) {
        return transaction.hostFeeInHostCurrency;
      },
    },
    platformFeeInHostCurrency: {
      type: GraphQLInt,
      description:
        'Fee kept by the Open Collective Platform in the lowest unit of the currency of the host (ie. in cents)',
      resolve(transaction) {
        return transaction.platformFeeInHostCurrency;
      },
    },
    paymentProcessorFeeInHostCurrency: {
      type: GraphQLInt,
      description: 'Fee kept by the payment processor in the lowest unit of the currency of the host (ie. in cents)',
      resolve(transaction) {
        return transaction.paymentProcessorFeeInHostCurrency;
      },
    },
    netAmountInCollectiveCurrency: {
      type: GraphQLInt,
      description: 'Amount after fees received by the collective in the lowest unit of its own currency (ie. cents)',
      resolve(transaction) {
        return transaction.netAmountInCollectiveCurrency;
      },
    },
    host: {
      type: UserCollectiveType,
      resolve(transaction) {
        if (transaction && transaction.getHostCollective) {
          return transaction.getHostCollective();
        }
        if (get(transaction, 'host.id')) {
          return models.Collective.findById(get(transaction, 'host.id'));
        }
        return null;
      },
    },
    createdByUser: {
      type: UserType,
      resolve(transaction) {
        if (transaction && transaction.getCreatedByUser) {
          return transaction.getCreatedByUser();
        }
        return null;
      },
    },
    fromCollective: {
      type: CollectiveInterfaceType,
      resolve(transaction) {
        if (transaction && transaction.getFromCollective) {
          return transaction.getFromCollective();
        }
        if (get(transaction, 'fromCollective.id')) {
          return models.Collective.findById(get(transaction, 'fromCollective.id'));
        }
        return null;
      },
    },
    usingVirtualCardFromCollective: {
      type: CollectiveInterfaceType,
      resolve(transaction) {
        if (transaction && transaction.getVirtualCardEmitterCollective) {
          return transaction.getVirtualCardEmitterCollective();
        }
        return null;
      },
    },
    collective: {
      type: CollectiveInterfaceType,
      resolve(transaction) {
        if (transaction && transaction.getCollective) {
          return transaction.getCollective();
        }
        if (get(transaction, 'collective.id')) {
          return models.Collective.findById(get(transaction, 'collective.id'));
        }
        return null;
      },
    },
    createdAt: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.createdAt;
      },
    },
    updatedAt: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.updatedAt;
      },
    },
    paymentMethod: {
      type: PaymentMethodType,
      resolve(transaction, args, req) {
        const paymentMethodId = transaction.PaymentMethodId || get(transaction, 'paymentMethod.id');
        if (!paymentMethodId) return null;
        // TODO: put behind a login check
        return req.loaders.paymentMethods.findById.load(paymentMethodId);
      },
    },
  };
};
export const TransactionExpenseType = new GraphQLObjectType({
  name: 'Expense',
  description: 'Expense model',
  interfaces: [TransactionInterfaceType],
  fields: () => {
    return {
      ...TransactionFields(),
      description: {
        type: GraphQLString,
        resolve(transaction) {
          const expense = transaction.getExpense
          ? transaction.getExpense().then(expense => expense && expense.description)
          : null;
          return (
            transaction.description ||
            expense
          );
        },
      },
      privateMessage: {
        type: GraphQLString,
        resolve(transaction, args, req) {
          return transaction.getExpenseForViewer
            ? transaction.getExpenseForViewer(req.remoteUser).then(expense => expense && expense.privateMessage)
            : null;
        },
      },
      category: {
        type: GraphQLString,
        resolve(transaction, args, req) {
          return transaction.getExpenseForViewer
            ? transaction.getExpenseForViewer(req.remoteUser).then(expense => expense && expense.category)
            : null;
        },
      },
      attachment: {
        type: GraphQLString,
        resolve(transaction, args, req) {
          return transaction.getExpenseForViewer
            ? transaction.getExpenseForViewer(req.remoteUser).then(expense => expense && expense.attachment)
            : null;
        },
      },
    };
  },
});

export const TransactionOrderType = new GraphQLObjectType({
  name: 'Order',
  description: 'Order model',
  interfaces: [TransactionInterfaceType],
  fields: () => {
    return {
      ...TransactionFields(),
      description: {
        type: GraphQLString,
        resolve(transaction) {
          const getOrder = transaction.getOrder
            ? transaction.getOrder().then(order => order && order.description)
            : null;
          return (
            transaction.description ||
            getOrder
          );
        },
      },
      privateMessage: {
        type: GraphQLString,
        resolve(transaction) {
          return transaction.getOrder
            ? transaction.getOrder().then(order => order && order.privateMessage)
            : null;
        },
      },
      publicMessage: {
        type: GraphQLString,
        resolve(transaction) {
          return transaction.getOrder
            ? transaction.getOrder().then(order => order && order.publicMessage)
            : null;
        },
      },
      order: {
        type: OrderType,
        resolve(transaction) {
          return transaction.getOrder
            ? transaction.getOrder()
            : null;
        },
      },
      subscription: {
        type: SubscriptionType,
        resolve(transaction) {
          return transaction.getOrder
            ? transaction.getOrder().then(order => order && order.getSubscription())
            : null;
        },
      },
    };
  },
});

export const TransactionType = new GraphQLEnumType({
  name: 'TransactionType',
  description: 'Type of transaction in the ledger',
  values: {
    CREDIT: {},
    DEBIT: {},
  },
});

export const OrderDirectionType = new GraphQLEnumType({
  name: 'OrderDirection',
  description: 'Possible directions in which to order a list of items when provided an orderBy argument.',
  values: {
    ASC: {},
    DESC: {},
  },
});

export const TransactionOrder = new GraphQLInputObjectType({
  name: 'TransactionOrder',
  description: 'Ordering options for transactions',
  fields: {
    field: {
      description: 'The field to order transactions by.',
      defaultValue: 'createdAt',
      type: new GraphQLEnumType({
        name: 'TransactionOrderField',
        description: 'Properties by which transactions can be ordered.',
        values: {
          CREATED_AT: {
            value: 'createdAt',
            description: 'Order transactions by creation time.',
          },
        },
      }),
    },
    direction: {
      description: 'The ordering direction.',
      defaultValue: 'DESC',
      type: OrderDirectionType,
    },
  },
});

TransactionOrder.defaultValue = Object.entries(TransactionOrder.getFields()).reduce(
  (values, [key, value]) => ({
    ...values,
    [key]: value.defaultValue,
  }),
  {},
);

export const PaginatedTransactionsType = new GraphQLObjectType({
  name: 'PaginatedTransactions',
  description: 'List of transactions with pagination data',
  fields: () => ({
    transactions: { type: new GraphQLList(TransactionInterfaceType) },
    limit: { type: GraphQLInt },
    offset: { type: GraphQLInt },
    total: { type: GraphQLInt },
  }),
});
