using System.Collections.Generic;
using FortyTwo.Client.Services;
using FortyTwo.Shared.DTO;

namespace FortyTwo.Client.Store
{
    public class ClientStore : IClientStore
    {
        public List<Match> Matches { get; set; } = new List<Match>();
        public List<User> Users { get; set; } = new List<User>();
    }
}
