using System;
using System.Collections.Concurrent;
using FortyTwo.Shared.DTO;

namespace FortyTwo.Client.Store
{
    public class ClientStore : IClientStore
    {
        public ConcurrentDictionary<Guid, Match> Matches { get; set; } = new ConcurrentDictionary<Guid, Match>();
        public ConcurrentDictionary<string, User> Users { get; set; } = new ConcurrentDictionary<string, User>();
    }
}
