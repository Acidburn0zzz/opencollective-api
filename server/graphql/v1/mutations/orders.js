import { pick, omit, get } from 'lodash';
import moment from 'moment';
import uuidv4 from 'uuid/v4';

import debug from 'debug';
import Promise from 'bluebird';

import models, { Op } from '../../../models';
import { capitalize, pluralize } from '../../../lib/utils';
import * as libPayments from '../../../lib/payments';
import { types } from '../../../constants/collectives';
import roles from '../../../constants/roles';
import status from '../../../constants/order_status';
import * as errors from '../../errors';
import activities from '../../../constants/activities';
import {
  getNextChargeAndPeriodStartDates,
  getChargeRetryCount,
} from '../../../lib/subscriptions';

const debugOrder = debug('order');

export async function createOrder(order, loaders, remoteUser) {
  try {
    if (
      order.paymentMethod &&
      order.paymentMethod.service === 'stripe' &&
      order.paymentMethod.uuid &&
      !remoteUser
    ) {
      throw new Error(
        'You need to be logged in to be able to use a payment method on file',
      );
    }

    if (
      !order.collective ||
      (!order.collective.id && !order.collective.website)
    ) {
      throw new Error('No collective id or website provided');
    }

    if (order.platformFeePercent && !remoteUser.isRoot()) {
      throw new Error('Only a root can change the platformFeePercent');
    }

    // Check the existence of the recipient Collective
    let collective;
    if (order.collective.id) {
      collective = await loaders.collective.findById.load(order.collective.id);
    } else if (order.collective.website) {
      collective = (await models.Collective.findOrCreate({
        where: { website: order.collective.website },
        defaults: order.collective,
      }))[0];
    }

    if (!collective) {
      throw new Error(
        `No collective found: ${order.collective.id ||
          order.collective.website}`,
      );
    }

    if (order.fromCollective && order.fromCollective.id === collective.id) {
      throw new Error(
        'Orders cannot be created for a collective by that same collective.',
      );
    }

    if (order.hostFeePercent) {
      const HostCollectiveId = await collective.getHostCollectiveId();

      if (!remoteUser.isAdmin(HostCollectiveId)) {
        throw new Error(
          'Only an admin of the host can change the hostFeePercent',
        );
      }
    }

    order.collective = collective;

    let tier;
    if (order.tier) {
      tier = await models.Tier.findById(order.tier.id);

      if (!tier) {
        throw new Error(
          `No tier found with tier id: ${order.tier.id} for collective slug ${
            order.collective.slug
          }`,
        );
      }
    }

    const paymentRequired =
      (order.totalAmount > 0 || (tier && tier.amount > 0)) &&
      collective.isActive;
    if (
      paymentRequired &&
      (!order.paymentMethod ||
        !(order.paymentMethod.uuid || order.paymentMethod.token))
    ) {
      throw new Error('This order requires a payment method');
    }

    if (
      tier &&
      tier.maxQuantityPerUser > 0 &&
      order.quantity > tier.maxQuantityPerUser
    ) {
      throw new Error(
        `You can buy up to ${tier.maxQuantityPerUser} ${pluralize(
          'ticket',
          tier.maxQuantityPerUser,
        )} per person`,
      );
    }

    if (tier) {
      const enoughQuantityAvailable = await tier.checkAvailableQuantity(
        order.quantity,
      );
      if (!enoughQuantityAvailable) {
        throw new Error(`No more tickets left for ${tier.name}`);
      }
    }

    // find or create user, check permissions to set `fromCollective`
    let user;
    if (order.user && order.user.email) {
      user = await models.User.findOrCreateByEmail(order.user.email, {
        ...order.user,
        currency: order.currency,
        CreatedByUserId: remoteUser ? remoteUser.id : null,
      });
    } else if (remoteUser) {
      user = remoteUser;
    }

    let fromCollective;
    if (
      !order.fromCollective ||
      (!order.fromCollective.id && !order.fromCollective.name)
    ) {
      fromCollective = await loaders.collective.findById.load(
        user.CollectiveId,
      );
    }

    // If a `fromCollective` is provided, we check its existence and if the user can create an order on its behalf
    if (order.fromCollective && order.fromCollective.id) {
      if (!remoteUser) {
        throw new Error(
          'You need to be logged in to create an order for an existing open collective',
        );
      }

      const nowLessOneHour = new Date();
      nowLessOneHour.setHours(nowLessOneHour.getHours() - 1);
      // Checking hourly limit of donations per fromCollective
      const fromCollectiveOrdersCountLastHourQuery = {
        FromCollectiveId: order.fromCollective.id,
        createdAt: { [Op.gt]: nowLessOneHour },
        type: 'CREDIT',
      };
      const fromCollectiveOrdersLastHourCount = await models.Transaction.count({
        where: fromCollectiveOrdersCountLastHourQuery,
      });
      if ( fromCollectiveOrdersLastHourCount > 10 ) {
        debugOrder('You have reached your hourly limit of donations');
        throw new Error('You have reached the hourly limit of donations');
      }
      // Checking hourly limit of donations per fromCollective and Collective
      const collectiveAndFromCollectiveOrdersCountLastHourQuery = {
        CollectiveId: order.collective.id,
        FromCollectiveId: order.fromCollective.id,
        createdAt: { [Op.gt]: nowLessOneHour },
        type: 'CREDIT',
      };
      const collectiveAndFromCollectiveOrdersLastHourCount = await models.Transaction.count({
        where: collectiveAndFromCollectiveOrdersCountLastHourQuery,
      });
      if ( collectiveAndFromCollectiveOrdersLastHourCount > 2 ) {
        debugOrder('You have reached the hourly limit of donations per collective');
        throw new Error('You have reached the hourly limit of donations per collective');
      }

      fromCollective = await loaders.collective.findById.load(
        order.fromCollective.id,
      );
      if (!fromCollective) {
        throw new Error(
          `From collective id ${order.fromCollective.id} not found`,
        );
      }

      const possibleRoles = [roles.ADMIN, roles.HOST];
      if (fromCollective.type === types.ORGANIZATION) {
        possibleRoles.push(roles.MEMBER);
      }

      if (!remoteUser.hasRole(possibleRoles, order.fromCollective.id)) {
        // We only allow to add funds on behalf of a collective if the user is an admin of that collective or an admin of the host of the collective that receives the money
        const HostId = await collective.getHostCollectiveId();
        if (!remoteUser.isAdmin(HostId)) {
          throw new Error(
            `You don't have sufficient permissions to create an order on behalf of the ${
              fromCollective.name
            } ${fromCollective.type.toLowerCase()}`,
          );
        }
      }
    }

    if (!fromCollective) {
      fromCollective = await models.Collective.createOrganization(
        order.fromCollective,
        user,
        remoteUser,
      );
    }

    let matchingFund;
    if (order.matchingFund) {
      matchingFund = await models.PaymentMethod.getMatchingFund(
        order.matchingFund,
        { ForCollectiveId: collective.id },
      );
      const canBeUsedForOrder = await matchingFund.canBeUsedForOrder(
        order,
        user,
      );

      if (!canBeUsedForOrder) {
        matchingFund = null;
      }
    }

    if (matchingFund) {
      order.matchingFund = matchingFund;
      order.MatchingPaymentMethodId = matchingFund.id;
      order.referral = { id: matchingFund.CollectiveId }; // if there is a matching fund, we force the referral to be the owner of the fund
    }

    const currency = (tier && tier.currency) || collective.currency;
    if (order.currency && order.currency !== currency) {
      throw new Error(`Invalid currency. Expected ${currency}.`);
    }

    const quantity = order.quantity || 1;

    let totalAmount;
    if (tier && tier.amount && !tier.presets) {
      // if the tier has presets, we can't enforce tier.amount
      totalAmount = tier.amount * quantity;
    } else {
      totalAmount = order.totalAmount; // e.g. the donor tier doesn't set an amount
    }

    const tierNameInfo = tier && tier.name ? ` (${tier.name})` : '';

    let defaultDescription;
    if (order.interval) {
      defaultDescription = `${capitalize(order.interval)}ly donation to ${
        collective.name
      }${tierNameInfo}`;
    } else {
      defaultDescription = `Donation to ${collective.name}${tierNameInfo}`;
    }

    const orderData = {
      CreatedByUserId: remoteUser ? remoteUser.id : user.id,
      FromCollectiveId: fromCollective.id,
      CollectiveId: collective.id,
      TierId: tier && tier.id,
      quantity,
      totalAmount,
      currency,
      interval: order.interval,
      description: order.description || defaultDescription,
      publicMessage: order.publicMessage,
      privateMessage: order.privateMessage,
      processedAt: (paymentRequired || !collective.isActive) ? null : new Date(),
      MatchingPaymentMethodId: order.MatchingPaymentMethodId,
    };

    if (
      order.referral &&
      get(order, 'referral.id') !== orderData.FromCollectiveId
    ) {
      orderData.ReferralCollectiveId = order.referral.id;
    }

    // using var so the scope is shared with the catch block below
    // eslint-disable-next-line no-var
    var orderCreated = await models.Order.create(orderData);
    orderCreated.interval = order.interval;
    orderCreated.matchingFund = order.matchingFund;

    if (order.paymentMethod && order.paymentMethod.save) {
      order.paymentMethod.CollectiveId = orderCreated.FromCollectiveId;
    }

    if (paymentRequired) {
      await orderCreated.setPaymentMethod(order.paymentMethod);
      // also adds the user as a BACKER of collective
      await libPayments.executeOrder(
        remoteUser || user,
        orderCreated,
        pick(order, ['hostFeePercent', 'platformFeePercent']),
      );
    } else if (
      !paymentRequired &&
      order.interval &&
      collective.type === types.COLLECTIVE
    ) {
      // create inactive subscription to hold the interval info
      const subscription = await models.Subscription.create({
        amount: order.totalAmount,
        interval: order.interval,
        currency: order.currency,
      });
      await orderCreated.update({ SubscriptionId: subscription.id });
    } else if (collective.type === types.EVENT) {
      // Free ticket, add user as an ATTENDEE
      const UserId = remoteUser ? remoteUser.id : user.id;
      await collective.addUserWithRole(user, roles.ATTENDEE);
      await models.Activity.create({
        type: activities.TICKET_CONFIRMED,
        data: {
          EventCollectiveId: collective.id,
          UserId,
          recipient: { name: fromCollective.name },
          order: orderCreated.info,
          tier: tier && tier.info,
        },
      });
    }

    order = await models.Order.findById(orderCreated.id);

    // If there was a referral for this order, we add it as a FUNDRAISER role
    if (
      order.ReferralCollectiveId &&
      order.ReferralCollectiveId !== user.CollectiveId
    ) {
      collective.addUserWithRole(
        { id: user.id, CollectiveId: order.ReferralCollectiveId },
        roles.FUNDRAISER,
      );
    }

    return order;
  } catch (error) {
    debugOrder('createOrder mutation error: ', error);
    if (orderCreated && !orderCreated.processedAt) {
      // TODO: Order should be updated with data JSON field to store the error to review later
      orderCreated.update({ status: status.ERROR });
    }
    throw error;
  }
}

export async function updateOrder(remoteUser, order) {
  if (!remoteUser) {
    throw new errors.Unauthorized({
      message: 'You need to be logged in to update an order',
    });
  }

  const existingOrder = await models.Order.findOne({
    where: {
      id: order.id,
    },
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.Collective, as: 'fromCollective' },
    ],
  });

  if (!existingOrder) {
    throw new errors.NotFound({
      message: 'Existing order not found',
    });
  }

  const paymentRequired =
    order.totalAmount > 0 && existingOrder.collective.isActive;

  if (
    paymentRequired &&
    (!order.paymentMethod ||
      !(order.paymentMethod.uuid || order.paymentMethod.token))
  ) {
    throw new Error('This order requires a payment method');
  }

  if (order.paymentMethod && order.paymentMethod.save) {
    order.paymentMethod.CollectiveId = existingOrder.FromCollectiveId;
  }

  if (paymentRequired) {
    existingOrder.interval = order.interval;
    await existingOrder.setPaymentMethod(order.paymentMethod);
    // also adds the user as a BACKER of collective
    await libPayments.executeOrder(
      remoteUser,
      existingOrder,
      pick(order, ['hostFeePercent', 'platformFeePercent']),
    );
  }
  await existingOrder.reload();
  return existingOrder;
}

export function cancelSubscription(remoteUser, orderId) {
  if (!remoteUser) {
    throw new errors.Unauthorized({
      message: 'You need to be logged in to cancel a subscription',
    });
  }

  let order = null;
  const query = {
    where: {
      id: orderId,
    },
    include: [
      { model: models.Subscription },
      { model: models.Collective, as: 'collective' },
      { model: models.Collective, as: 'fromCollective' },
    ],
  };
  return (
    models.Order.findOne(query)
      .tap(o => (order = o))
      .tap(order => {
        if (!order) {
          throw new Error('Subscription not found');
        }
        return Promise.resolve();
      })
      .tap(order => {
        if (!remoteUser.isAdmin(order.FromCollectiveId)) {
          throw new errors.Unauthorized({
            message: "You don't have permission to cancel this subscription",
          });
        }
        return Promise.resolve();
      })
      .tap(order => {
        if (!order.Subscription.isActive && order.status === status.CANCELLED) {
          throw new Error('Subscription already canceled');
        }
        return Promise.resolve();
      })
      .then(order =>
        Promise.all([
          order.update({ status: status.CANCELLED }),
          order.Subscription.deactivate(),
        ]),
      )

      // createActivity - that sends out the email
      .then(() =>
        models.Activity.create({
          type: activities.SUBSCRIPTION_CANCELED,
          CollectiveId: order.CollectiveId,
          UserId: order.CreatedByUserId,
          data: {
            subscription: order.Subscription,
            collective: order.collective.minimal,
            user: remoteUser.minimal,
            fromCollective: order.fromCollective.minimal,
          },
        }),
      )
      .then(() => models.Order.findOne(query))
  ); // need to fetch it second time to get updated data.
}

export async function updateSubscription(remoteUser, args) {
  if (!remoteUser) {
    throw new errors.Unauthorized({
      message: 'You need to be logged in to update a subscription',
    });
  }

  const { id, paymentMethod, amount } = args;

  const query = {
    where: {
      id,
    },
    include: [
      { model: models.Subscription },
      { model: models.PaymentMethod, as: 'paymentMethod' },
    ],
  };

  let order = await models.Order.findOne(query);

  if (!order) {
    throw new Error('Subscription not found');
  }
  if (!remoteUser.isAdmin(order.FromCollectiveId)) {
    throw new errors.Unauthorized({
      message: "You don't have permission to update this subscription",
    });
  }
  if (!order.Subscription.isActive) {
    throw new Error('Subscription must be active to be updated');
  }

  if (paymentMethod !== undefined) {
    let newPm;

    // TODO: Would be even better if we could charge you here directly
    // before letting you proceed

    // means it's an existing paymentMethod
    if (paymentMethod.uuid && paymentMethod.uuid.length === 36) {
      newPm = await models.PaymentMethod.findOne({
        where: { uuid: paymentMethod.uuid },
      });
      if (!newPm) {
        throw new Error(
          'Payment method not found with this uuid',
          paymentMethod.uuid,
        );
      }
    } else {
      // means it's a new paymentMethod
      const newPMData = Object.assign(paymentMethod, {
        CollectiveId: order.FromCollectiveId,
      });
      newPm = await models.PaymentMethod.createFromStripeSourceToken(newPMData);
    }

    // determine if this order was pastdue
    if (order.Subscription.chargeRetryCount > 0) {
      const updatedDates = getNextChargeAndPeriodStartDates('updated', order);
      const chargeRetryCount = getChargeRetryCount('updated', order);

      await order.Subscription.update({
        nextChargeDate: updatedDates.nextChargeDate,
        chargeRetryCount,
      });
    }

    order = await order.update({ PaymentMethodId: newPm.id });
  }

  if (amount !== undefined) {
    if (amount == order.Subscription.amount) {
      throw new Error('Same amount');
    }

    if (amount < 100 || amount % 100 !== 0) {
      throw new Error('Invalid amount');
    }

    order.Subscription.deactivate();

    const newSubscriptionDataValues = Object.assign(
      omit(order.Subscription.dataValues, ['id', 'deactivatedAt']),
      {
        amount: amount,
        updatedAt: new Date(),
        activatedAt: new Date(),
        isActive: true,
      },
    );

    const newSubscription = await models.Subscription.create(
      newSubscriptionDataValues,
    );

    const newOrderDataValues = Object.assign(omit(order.dataValues, ['id']), {
      totalAmount: amount,
      SubscriptionId: newSubscription.id,
      updatedAt: new Date(),
    });

    order = await models.Order.create(newOrderDataValues);
  }

  return order;
}

export async function refundTransaction(_, args, req) {
  // 0. Retrieve transaction from database
  const transaction = await models.Transaction.findById(args.id, {
    include: [models.Order, models.PaymentMethod],
  });
  if (!transaction) {
    throw new errors.NotFound({ message: 'Transaction not found' });
  }

  // 1. Verify user permission. User must be either
  //   a. User that created transaction (within 24h) -- Not implemented yet
  //   b. Host Collective receiving the donation -- Not implemented yet
  //   c. Site Admin
  if (!req.remoteUser.isRoot()) {
    throw new errors.Unauthorized({ message: 'Not a site admin' });
  }

  // 2. Refund via payment method
  // 3. Create new transactions with the refund value in our database
  const result = await libPayments.refundTransaction(
    transaction,
    req.remoteUser,
  );

  // Return the transaction passed to the `refundTransaction` method
  // after it was updated.
  return result;
}

/** Create prepaid payment method that can be used by an organization
 *
 * @param {Object} args contains the parameters to create the new
 *  payment method.
 * @param {String} args.description The description of the new payment
 *  method.
 * @param {Number} args.CollectiveId The ID of the organization
 *  receiving the prepaid card.
 * @param {Number} args.HostCollectiveId The ID of the host that
 *  received the money on its bank account.
 * @param {Number} args.totalAmount The total amount that will be
 *  credited to the newly created payment method.
 * @param {models.User} remoteUser is the user creating the new credit
 *  card. Right now only site admins can use this feature.
 */
export async function addFundsToOrg(args, remoteUser) {
  if (!remoteUser.isRoot())
    throw new Error('Only site admins can perform this operation');
  const [fromCollective, hostCollective] = await Promise.all([
    models.Collective.findById(args.CollectiveId),
    models.Collective.findById(args.HostCollectiveId),
  ]);
  // creates a new Payment method
  const paymentMethod = await models.PaymentMethod.create({
    name: args.description || 'Host funds',
    initialBalance: args.totalAmount,
    monthlyLimitPerMember: null,
    currency: hostCollective.currency,
    CollectiveId: args.CollectiveId,
    customerId: fromCollective.slug,
    expiryDate: moment()
      .add(1, 'year')
      .format(),
    uuid: uuidv4(),
    data: { HostCollectiveId: args.HostCollectiveId },
    service: 'opencollective',
    type: 'prepaid',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return paymentMethod;
}